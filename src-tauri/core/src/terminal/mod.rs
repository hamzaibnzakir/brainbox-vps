//! Terminal session registry (SSH and local).

pub mod local;
pub mod remote;

use crate::error::{AppError, ErrorCode, Result};
use crate::events::StreamFn;
use crate::model::{TerminalEvent, TerminalInfo, TerminalOpenRequest};
use crate::ssh::ConnectionManager;
use local::LocalPty;
use parking_lot::Mutex;
use remote::{Mode, RemoteSession, RemoteSpec, TermCmd};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

enum Handle {
    Remote { tx: mpsc::UnboundedSender<TermCmd>, cancel: CancellationToken },
    Local(Arc<LocalPty>),
}

struct Entry {
    handle: Handle,
    info: TerminalInfo,
}

pub struct TerminalManager {
    conns: Arc<ConnectionManager>,
    sessions: Arc<Mutex<HashMap<String, Entry>>>,
}

impl TerminalManager {
    pub fn new(conns: Arc<ConnectionManager>) -> Self {
        Self { conns, sessions: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub async fn open_remote(&self, req: TerminalOpenRequest, sink: StreamFn<TerminalEvent>) -> Result<TerminalInfo> {
        let conn = self.conns.require(&req.server_id)?;
        let profile = conn.profile();
        let mut tmux_session = None;
        let mode = if let Some(cmd) = req.command.clone() {
            Mode::Exec(cmd)
        } else if req.tmux_session.is_some() || profile.use_tmux {
            if remote::tmux_available(&conn).await {
                let name = remote::tmux_name(
                    &req.tmux_session.clone().unwrap_or_else(|| format!("bbx-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])),
                );
                tmux_session = Some(name.clone());
                Mode::Tmux(name)
            } else {
                Mode::Shell
            }
        } else {
            Mode::Shell
        };
        let spec = RemoteSpec {
            mode,
            cwd: req.cwd.clone().or_else(|| profile.startup_dir.clone()),
            startup_command: if req.command.is_none() { profile.startup_command.clone() } else { None },
        };
        let first = remote::open_channel(&conn, &spec, req.cols, req.rows).await?;
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let info = TerminalInfo { id: id.clone(), server_id: Some(req.server_id.clone()), title: profile.name.clone(), tmux_session };
        self.sessions.lock().insert(id.clone(), Entry { handle: Handle::Remote { tx, cancel: cancel.clone() }, info: info.clone() });

        let sessions = self.sessions.clone();
        let sid = id.clone();
        let wrapped: StreamFn<TerminalEvent> = {
            let sink = sink.clone();
            let sessions = sessions.clone();
            let sid = sid.clone();
            Arc::new(move |ev: TerminalEvent| {
                let exit = matches!(ev, TerminalEvent::Exit { .. });
                sink(ev);
                if exit {
                    sessions.lock().remove(&sid);
                }
            })
        };
        let session = RemoteSession { conn, spec, rx, cancel, sink: wrapped, size: (req.cols, req.rows) };
        crate::rt::spawn(session.run(first));
        Ok(info)
    }

    pub fn open_local(&self, shell_id: Option<&str>, cols: u16, rows: u16, cwd: Option<&str>, sink: StreamFn<TerminalEvent>) -> Result<TerminalInfo> {
        let shells = local::detect_shells();
        let shell = match shell_id {
            Some(id) => shells.iter().find(|s| s.id == id).cloned(),
            None => shells.iter().find(|s| s.is_default).cloned(),
        }
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Shell not found", "That shell is not installed on this computer."))?;
        let id = uuid::Uuid::new_v4().to_string();
        let sessions = self.sessions.clone();
        let sid = id.clone();
        let wrapped: StreamFn<TerminalEvent> = Arc::new(move |ev: TerminalEvent| {
            let exit = matches!(ev, TerminalEvent::Exit { .. });
            sink(ev);
            if exit {
                sessions.lock().remove(&sid);
            }
        });
        let pty = LocalPty::spawn(&shell, cols, rows, cwd, wrapped)?;
        let info = TerminalInfo { id: id.clone(), server_id: None, title: shell.name.clone(), tmux_session: None };
        self.sessions.lock().insert(id, Entry { handle: Handle::Local(pty), info: info.clone() });
        Ok(info)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let s = self.sessions.lock();
        match s.get(id).map(|e| &e.handle) {
            Some(Handle::Remote { tx, .. }) => tx.send(TermCmd::Input(data.to_vec())).map_err(|_| remote::not_found(id)),
            Some(Handle::Local(p)) => p.write(data),
            None => Err(remote::not_found(id)),
        }
    }

    pub fn resize(&self, id: &str, cols: u32, rows: u32) -> Result<()> {
        let s = self.sessions.lock();
        match s.get(id).map(|e| &e.handle) {
            Some(Handle::Remote { tx, .. }) => tx.send(TermCmd::Resize(cols, rows)).map_err(|_| remote::not_found(id)),
            Some(Handle::Local(p)) => {
                p.resize(cols as u16, rows as u16);
                Ok(())
            }
            None => Err(remote::not_found(id)),
        }
    }

    pub fn close(&self, id: &str) {
        if let Some(e) = self.sessions.lock().remove(id) {
            match e.handle {
                Handle::Remote { cancel, .. } => cancel.cancel(),
                Handle::Local(p) => p.kill(),
            }
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        self.sessions.lock().values().map(|e| e.info.clone()).collect()
    }
}
