//! Interactive SSH shells (PTY channels) that survive reconnects.

use crate::error::{humanize_russh, AppError, NetCtx, Result};
use crate::events::StreamFn;
use crate::model::TerminalEvent;
use crate::ssh::connection::ServerConnection;
use crate::ssh::exec::{exec, ExecOptions};
use crate::ssh::quote::sh_quote;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub enum TermCmd {
    Input(Vec<u8>),
    Resize(u32, u32),
}

#[derive(Debug, Clone)]
pub enum Mode {
    Shell,
    Tmux(String),
    Exec(String),
}

#[derive(Debug, Clone)]
pub struct RemoteSpec {
    pub mode: Mode,
    pub cwd: Option<String>,
    pub startup_command: Option<String>,
}

pub async fn tmux_available(conn: &ServerConnection) -> bool {
    if let Some(v) = conn.probe_get("tmux") {
        return v == "1";
    }
    let ok = exec(conn, "command -v tmux >/dev/null 2>&1 && echo yes", ExecOptions::timeout(10))
        .await
        .map(|o| o.stdout.trim() == "yes")
        .unwrap_or(false);
    conn.probe_set("tmux", if ok { "1".into() } else { "0".into() });
    ok
}

/// Sanitise a tmux session name (tmux forbids `.` and `:`).
pub fn tmux_name(s: &str) -> String {
    let n: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let n = n.trim_matches('-').to_string();
    if n.is_empty() { "brainbox".into() } else { n.chars().take(48).collect() }
}

pub fn tmux_command(name: &str, cwd: Option<&str>) -> String {
    let mut c = format!("tmux new-session -A -s {}", sh_quote(name));
    if let Some(d) = cwd {
        c.push_str(&format!(" -c {}", sh_quote(d)));
    }
    // Mouse mode only for Brainbox-managed sessions so wheel scrolling works.
    c.push_str(" \\; set-option -q mouse on");
    c
}

pub(crate) async fn open_channel(conn: &ServerConnection, spec: &RemoteSpec, cols: u32, rows: u32) -> Result<Channel<Msg>> {
    let ctx = {
        let p = conn.profile.lock();
        NetCtx::ssh(&p.host, p.port)
    };
    let h = conn.handle()?;
    let ch = h.channel_open_session().await.map_err(|e| humanize_russh(&e, &ctx))?;
    ch.request_pty(false, "xterm-256color", cols.max(2), rows.max(1), 0, 0, &[])
        .await
        .map_err(|e| humanize_russh(&e, &ctx))?;
    let _ = ch.set_env(false, "COLORTERM", "truecolor").await;
    let _ = ch.set_env(false, "TERM_PROGRAM", "BrainboxVPS").await;
    match &spec.mode {
        Mode::Shell => ch.request_shell(false).await,
        Mode::Tmux(name) => ch.exec(false, tmux_command(name, spec.cwd.as_deref()).as_bytes()).await,
        Mode::Exec(cmd) => ch.exec(false, cmd.as_bytes()).await,
    }
    .map_err(|e| humanize_russh(&e, &ctx))?;
    if matches!(spec.mode, Mode::Shell) {
        let mut init = String::new();
        if let Some(d) = &spec.cwd {
            init.push_str(&format!("cd {} 2>/dev/null\n", sh_quote(d)));
        }
        if let Some(c) = &spec.startup_command {
            init.push_str(c);
            init.push('\n');
        }
        if !init.is_empty() {
            let _ = ch.data(init.as_bytes()).await;
        }
    }
    Ok(ch)
}

enum PumpEnd {
    Exit(Option<u32>),
    UserClosed,
    Lost,
}

fn emit_data(sink: &StreamFn<TerminalEvent>, buf: &mut Vec<u8>) {
    if !buf.is_empty() {
        sink(TerminalEvent::Data { data: B64.encode(&buf[..]) });
        buf.clear();
    }
}

async fn pump(
    ch: Channel<Msg>,
    rx: &mut mpsc::UnboundedReceiver<TermCmd>,
    cancel: &CancellationToken,
    sink: &StreamFn<TerminalEvent>,
    size: &mut (u32, u32),
) -> PumpEnd {
    let (mut read, write) = ch.split();
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut flush_at: Option<tokio::time::Instant> = None;
    let mut exit: Option<u32> = None;
    let end = loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                let _ = write.close().await;
                break PumpEnd::UserClosed;
            }
            cmd = rx.recv() => match cmd {
                Some(TermCmd::Input(b)) => {
                    if write.data(&b[..]).await.is_err() { break PumpEnd::Lost; }
                }
                Some(TermCmd::Resize(c, r)) => {
                    *size = (c, r);
                    let _ = write.window_change(c, r, 0, 0).await;
                }
                None => { let _ = write.close().await; break PumpEnd::UserClosed; }
            },
            _ = async { tokio::time::sleep_until(flush_at.unwrap()).await }, if flush_at.is_some() => {
                emit_data(sink, &mut buf);
                flush_at = None;
            }
            msg = read.wait() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    buf.extend_from_slice(&data);
                    if buf.len() >= 128 * 1024 {
                        emit_data(sink, &mut buf);
                        flush_at = None;
                    } else if flush_at.is_none() {
                        // Coalesce bursts of output into one IPC message (~1 frame).
                        flush_at = Some(tokio::time::Instant::now() + Duration::from_millis(6));
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                Some(ChannelMsg::ExitSignal { .. }) => exit = exit.or(Some(255)),
                Some(ChannelMsg::Close) | None => break PumpEnd::Exit(exit),
                _ => {}
            }
        }
    };
    emit_data(sink, &mut buf);
    end
}

pub(crate) struct RemoteSession {
    pub conn: Arc<ServerConnection>,
    pub spec: RemoteSpec,
    pub rx: mpsc::UnboundedReceiver<TermCmd>,
    pub cancel: CancellationToken,
    pub sink: StreamFn<TerminalEvent>,
    pub size: (u32, u32),
}

impl RemoteSession {
    pub async fn run(mut self, first: Channel<Msg>) {
        let mut ch = Some(first);
        loop {
            let Some(c) = ch.take() else { break };
            let end = pump(c, &mut self.rx, &self.cancel, &self.sink, &mut self.size).await;
            match end {
                PumpEnd::UserClosed => break,
                PumpEnd::Exit(code) => {
                    // A missing exit status + a dying connection means "lost", not "exited".
                    let lost = if code.is_none() {
                        let mut lost = false;
                        for _ in 0..8 {
                            if !self.conn.is_connected() {
                                lost = true;
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(250)).await;
                        }
                        lost
                    } else {
                        false
                    };
                    if !lost {
                        (self.sink)(TerminalEvent::Exit { code });
                        break;
                    }
                }
                PumpEnd::Lost => {}
            }
            // Connection lost: suspend until the supervisor reconnects.
            (self.sink)(TerminalEvent::Suspended);
            let gen = self.conn.generation();
            // Discard keystrokes typed while offline but keep the latest size.
            let waiter = self.conn.wait_connected(gen, &self.cancel);
            tokio::pin!(waiter);
            let reconnected = loop {
                tokio::select! {
                    r = &mut waiter => break r,
                    cmd = self.rx.recv() => match cmd {
                        Some(TermCmd::Resize(c, r)) => self.size = (c, r),
                        Some(TermCmd::Input(_)) => {}
                        None => break None,
                    }
                }
            };
            if reconnected.is_none() {
                (self.sink)(TerminalEvent::Exit { code: None });
                break;
            }
            match open_channel(&self.conn, &self.spec, self.size.0, self.size.1).await {
                Ok(c) => {
                    if !matches!(self.spec.mode, Mode::Tmux(_)) {
                        let note = "\r\n\x1b[38;5;141m● Brainbox VPS: reconnected — this is a new shell session.\x1b[0m\r\n";
                        (self.sink)(TerminalEvent::Data { data: B64.encode(note) });
                    }
                    (self.sink)(TerminalEvent::Resumed);
                    ch = Some(c);
                }
                Err(e) => {
                    (self.sink)(TerminalEvent::Error { error: e });
                    (self.sink)(TerminalEvent::Exit { code: None });
                    break;
                }
            }
        }
    }
}

pub fn not_found(id: &str) -> AppError {
    AppError::new(crate::error::ErrorCode::NotFound, "Terminal closed", "This terminal session no longer exists.").details(id.to_string())
}
