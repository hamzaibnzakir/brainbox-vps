//! Local shells (PowerShell, Command Prompt, Git Bash, WSL, bash/zsh…).

use crate::error::{AppError, ErrorCode, Result};
use crate::events::StreamFn;
use crate::model::{LocalShellInfo, TerminalEvent};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Detect shells available on this computer.
pub fn detect_shells() -> Vec<LocalShellInfo> {
    let mut out: Vec<LocalShellInfo> = Vec::new();
    let mut add = |id: &str, name: &str, path: PathBuf, args: Vec<String>| {
        if path.is_file() && !out.iter().any(|s| Path::new(&s.path) == path) {
            out.push(LocalShellInfo { id: id.into(), name: name.into(), path: path.to_string_lossy().into(), args, is_default: false });
        }
    };

    #[cfg(windows)]
    {
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        if let Some(p) = find_in_path("pwsh.exe") {
            add("pwsh", "PowerShell 7", p, vec!["-NoLogo".into()]);
        }
        for base in [std::env::var("ProgramFiles").ok(), Some(r"C:\Program Files".into())].into_iter().flatten() {
            add("pwsh", "PowerShell 7", PathBuf::from(&base).join(r"PowerShell\7\pwsh.exe"), vec!["-NoLogo".into()]);
        }
        add(
            "powershell",
            "Windows PowerShell",
            PathBuf::from(&sysroot).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
            vec!["-NoLogo".into()],
        );
        let cmd = std::env::var("ComSpec").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(&sysroot).join(r"System32\cmd.exe"));
        add("cmd", "Command Prompt", cmd, vec![]);
        for base in [std::env::var("ProgramFiles").ok(), Some(r"C:\Program Files".into())].into_iter().flatten() {
            add("gitbash", "Git Bash", PathBuf::from(base).join(r"Git\bin\bash.exe"), vec!["--login".into(), "-i".into()]);
        }
        add("wsl", "WSL", PathBuf::from(&sysroot).join(r"System32\wsl.exe"), vec![]);
    }
    #[cfg(not(windows))]
    {
        if let Ok(sh) = std::env::var("SHELL") {
            let name = Path::new(&sh).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "shell".into());
            add(&name.clone(), &name, PathBuf::from(&sh), vec!["-l".into()]);
        }
        for (id, p) in [("bash", "/bin/bash"), ("zsh", "/bin/zsh"), ("zsh", "/usr/bin/zsh"), ("fish", "/usr/bin/fish"), ("sh", "/bin/sh")] {
            add(id, id, PathBuf::from(p), if id == "sh" { vec![] } else { vec!["-l".into()] });
        }
    }
    if let Some(first) = out.first_mut() {
        first.is_default = true;
    }
    out
}

pub struct LocalPty {
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

impl LocalPty {
    pub fn spawn(shell: &LocalShellInfo, cols: u16, rows: u16, cwd: Option<&str>, sink: StreamFn<TerminalEvent>) -> Result<Arc<Self>> {
        let err = |e: anyhow_like::E| {
            AppError::new(ErrorCode::Io, "Could not start shell", format!("{} could not be started.", shell.name)).details(e.0)
        };
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: rows.max(1), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| err(anyhow_like::E(e.to_string())))?;
        let mut cmd = CommandBuilder::new(&shell.path);
        for a in &shell.args {
            cmd.arg(a);
        }
        let dir = cwd.map(PathBuf::from).filter(|p| p.is_dir()).or_else(dirs::home_dir);
        if let Some(d) = dir {
            cmd.cwd(d);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "BrainboxVPS");
        let child = pair.slave.spawn_command(cmd).map_err(|e| err(anyhow_like::E(e.to_string())))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| err(anyhow_like::E(e.to_string())))?;
        let writer = pair.master.take_writer().map_err(|e| err(anyhow_like::E(e.to_string())))?;
        let me = Arc::new(Self { writer: Mutex::new(writer), master: Mutex::new(pair.master), child: Mutex::new(child) });
        let weak = Arc::downgrade(&me);
        std::thread::Builder::new()
            .name("local-pty-reader".into())
            .spawn(move || {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => sink(TerminalEvent::Data { data: B64.encode(&buf[..n]) }),
                    }
                }
                let code = weak.upgrade().and_then(|m| m.child.lock().wait().ok()).map(|s| s.exit_code());
                sink(TerminalEvent::Exit { code });
            })
            .map_err(|e| AppError::internal(e.to_string()))?;
        Ok(me)
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock();
        w.write_all(data).and_then(|_| w.flush()).map_err(|e| AppError::new(ErrorCode::Io, "Shell closed", "The local shell is no longer running.").details(e.to_string()))
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.lock().resize(PtySize { rows: rows.max(1), cols: cols.max(2), pixel_width: 0, pixel_height: 0 });
    }

    pub fn kill(&self) {
        let _ = self.child.lock().kill();
    }
}

mod anyhow_like {
    pub struct E(pub String);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_at_least_one_shell() {
        let s = detect_shells();
        assert!(!s.is_empty());
        assert_eq!(s.iter().filter(|x| x.is_default).count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn local_pty_roundtrip() {
        let (tx, rx) = std::sync::mpsc::channel::<TerminalEvent>();
        let tx = Mutex::new(tx);
        let sink: StreamFn<TerminalEvent> = Arc::new(move |e| {
            let _ = tx.lock().send(e);
        });
        let sh = LocalShellInfo { id: "sh".into(), name: "sh".into(), path: "/bin/sh".into(), args: vec![], is_default: true };
        let pty = LocalPty::spawn(&sh, 80, 24, None, sink).unwrap();
        pty.write(b"echo bbx-$((40+2))\nexit 3\n").unwrap();
        let mut out = Vec::new();
        let mut code = None;
        while let Ok(ev) = rx.recv_timeout(std::time::Duration::from_secs(10)) {
            match ev {
                TerminalEvent::Data { data } => out.extend(B64.decode(data).unwrap()),
                TerminalEvent::Exit { code: c } => {
                    code = c;
                    break;
                }
                _ => {}
            }
        }
        assert!(String::from_utf8_lossy(&out).contains("bbx-42"));
        assert_eq!(code, Some(3));
    }
}
