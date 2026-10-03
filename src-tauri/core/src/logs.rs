//! Unified log streaming (journal, services, Docker, files) and export.
//! Logs are streamed line-by-line; nothing is loaded wholesale into memory.

use crate::error::{humanize_fs_io, humanize_russh, AppError, NetCtx, Result};
use crate::events::StreamFn;
use crate::model::{LogFileCandidate, LogSource, LogStreamRequest, StreamEvent};
use crate::privileged::{sudo_wrap, SudoCache};
use crate::ssh::exec::{exec, exec_stream, ExecOptions};
use crate::ssh::quote::{sh_quote, sh_script};
use crate::ssh::{ConnectionManager, ServerConnection};
use parking_lot::Mutex;
use russh::ChannelMsg;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

pub async fn build_command(conn: &ServerConnection, source: &LogSource, lines: u32, follow: bool) -> Result<String> {
    let n = lines.clamp(0, 100_000);
    let f = if follow { "-f" } else { "" };
    Ok(match source {
        LogSource::System => sh_script(&format!(
            "if command -v journalctl >/dev/null 2>&1; then journalctl -n {n} --no-pager -o short-iso {f}; \
             elif [ -r /var/log/syslog ]; then tail -n {n} {} /var/log/syslog; \
             else tail -n {n} {} /var/log/messages; fi",
            if follow { "-F" } else { "" },
            if follow { "-F" } else { "" }
        )),
        LogSource::Service { unit } => {
            crate::monitoring::valid_unit(unit)?;
            sh_script(&format!("journalctl -u {} -n {n} --no-pager -o short-iso {f}", sh_quote(unit)))
        }
        LogSource::Docker { container } => crate::docker::logs_command(conn, container, n, follow).await?,
        LogSource::File { path } => {
            if path.trim().is_empty() {
                return Err(AppError::invalid("Choose a log file."));
            }
            sh_script(&format!("tail -n {n} {} -- {}", if follow { "-F" } else { "" }, sh_quote(path)))
        }
    })
}

fn wrap_sudo(cmd: String, sudo: bool, cached: bool) -> String {
    if sudo {
        sudo_wrap(&cmd, cached)
    } else {
        cmd
    }
}

/// Active log streams.
pub struct LogStreams {
    conns: Arc<ConnectionManager>,
    sudo: Arc<SudoCache>,
    active: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl LogStreams {
    pub fn new(conns: Arc<ConnectionManager>, sudo: Arc<SudoCache>) -> Self {
        Self { conns, sudo, active: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub async fn start(&self, req: LogStreamRequest, sink: StreamFn<StreamEvent>) -> Result<String> {
        let conn = self.conns.require(&req.server_id)?;
        let mut cmd = build_command(&conn, &req.source, req.lines, req.follow).await?;
        let pw = if req.sudo { self.sudo.get(&req.server_id) } else { None };
        cmd = wrap_sudo(cmd, req.sudo, pw.is_some());
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        self.active.lock().insert(id.clone(), cancel.clone());
        let active = self.active.clone();
        let sid = id.clone();
        crate::rt::spawn(async move {
            let res = if let Some(p) = pw {
                // sudo -S reads the password from stdin first.
                stream_with_stdin(&conn, &cmd, format!("{}\n", p.expose()).into_bytes(), cancel, sink.clone()).await
            } else {
                exec_stream(&conn, &cmd, req.follow, cancel, sink.clone()).await.map(|_| ())
            };
            if let Err(e) = res {
                sink(StreamEvent::Error { error: e });
            }
            active.lock().remove(&sid);
        });
        Ok(id)
    }

    pub fn stop(&self, id: &str) {
        if let Some(c) = self.active.lock().remove(id) {
            c.cancel();
        }
    }

    pub fn stop_all(&self) {
        for (_, c) in self.active.lock().drain() {
            c.cancel();
        }
    }
}

async fn stream_with_stdin(conn: &ServerConnection, cmd: &str, stdin: Vec<u8>, cancel: CancellationToken, sink: StreamFn<StreamEvent>) -> Result<()> {
    // Like exec_stream, but writes stdin first (no PTY so the password isn't echoed).
    let h = conn.handle()?;
    let ctx = {
        let p = conn.profile();
        NetCtx::ssh(&p.host, p.port)
    };
    let mut ch = h.channel_open_session().await.map_err(|e| humanize_russh(&e, &ctx))?;
    ch.exec(true, cmd.as_bytes()).await.map_err(|e| humanize_russh(&e, &ctx))?;
    ch.data(&stdin[..]).await.map_err(|e| humanize_russh(&e, &ctx))?;
    let mut partial = Vec::new();
    let mut code = None;
    loop {
        tokio::select! {
            _ = cancel.cancelled() => { let _ = ch.close().await; break; }
            m = ch.wait() => match m {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    partial.extend_from_slice(&data);
                    let mut lines = Vec::new();
                    while let Some(pos) = partial.iter().position(|&b| b == b'\n') {
                        let l: Vec<u8> = partial.drain(..=pos).collect();
                        lines.push(String::from_utf8_lossy(&l[..l.len() - 1]).trim_end_matches('\r').to_string());
                    }
                    if !lines.is_empty() { sink(StreamEvent::Lines { lines }); }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
    }
    if !partial.is_empty() {
        sink(StreamEvent::Lines { lines: vec![String::from_utf8_lossy(&partial).into_owned()] });
    }
    sink(StreamEvent::End { code });
    Ok(())
}

/// Stream a log (journal/service/docker/file) straight into a local file.
pub async fn export(conn: &ServerConnection, sudo: &SudoCache, source: &LogSource, use_sudo: bool, local_path: &str) -> Result<u64> {
    let cmd = build_command(conn, source, 100_000, false).await?;
    let pw = if use_sudo { sudo.get(&conn.server_id) } else { None };
    let cmd = wrap_sudo(cmd, use_sudo, pw.is_some());
    let h = conn.handle()?;
    let ctx = NetCtx::ssh(&conn.profile().host, conn.profile().port);
    let mut ch = h.channel_open_session().await.map_err(|e| humanize_russh(&e, &ctx))?;
    ch.exec(true, cmd.as_bytes()).await.map_err(|e| humanize_russh(&e, &ctx))?;
    if let Some(p) = pw {
        let _ = ch.data(format!("{}\n", p.expose()).as_bytes()).await;
    }
    let mut f = tokio::fs::File::create(local_path).await.map_err(|e| humanize_fs_io(&e, local_path))?;
    let mut total = 0u64;
    while let Some(m) = ch.wait().await {
        match m {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                f.write_all(&data).await.map_err(|e| humanize_fs_io(&e, local_path))?;
                total += data.len() as u64;
            }
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    f.flush().await.map_err(|e| humanize_fs_io(&e, local_path))?;
    Ok(total)
}

/// Suggest log files worth viewing.
pub async fn discover_files(conn: &ServerConnection) -> Result<Vec<LogFileCandidate>> {
    let script = "find /var/log \"$HOME/.pm2/logs\" /var/www -maxdepth 4 -type f \\( -name '*.log' -o -name 'syslog' -o -name 'messages' -o -name '*.err' -o -name '*.out' \\) -size +0 -printf '%s\\t%p\\n' 2>/dev/null | sort -t\"$(printf '\\t')\" -k2 | head -n 500";
    let out = exec(conn, &sh_script(script), ExecOptions::timeout(30)).await?;
    Ok(out
        .stdout
        .lines()
        .filter_map(|l| {
            let (s, p) = l.split_once('\t')?;
            Some(LogFileCandidate { path: p.to_string(), size: s.parse().unwrap_or(0) })
        })
        .collect())
}
