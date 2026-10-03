//! Non-interactive command execution over SSH channels.

use super::connection::ServerConnection;
use crate::error::{humanize_russh, AppError, ErrorCode, NetCtx, Result};
use crate::events::StreamFn;
use crate::model::{ExecOutput, StreamEvent};
use russh::ChannelMsg;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub struct ExecOptions {
    pub timeout: Duration,
    pub max_output: usize,
    pub stdin: Option<Vec<u8>>,
}

impl Default for ExecOptions {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(60), max_output: 8 * 1024 * 1024, stdin: None }
    }
}

impl ExecOptions {
    pub fn timeout(secs: u64) -> Self {
        Self { timeout: Duration::from_secs(secs), ..Default::default() }
    }
}

fn ctx(conn: &ServerConnection) -> NetCtx {
    let p = conn.profile.lock();
    NetCtx::ssh(&p.host, p.port)
}

/// Run a command and collect its output.
pub async fn exec(conn: &ServerConnection, command: &str, opts: ExecOptions) -> Result<ExecOutput> {
    let handle = conn.handle()?;
    let started = Instant::now();
    let mut ch = handle.channel_open_session().await.map_err(|e| humanize_russh(&e, &ctx(conn)))?;
    ch.exec(true, command.as_bytes()).await.map_err(|e| humanize_russh(&e, &ctx(conn)))?;
    if let Some(input) = &opts.stdin {
        ch.data(&input[..]).await.map_err(|e| humanize_russh(&e, &ctx(conn)))?;
        let _ = ch.eof().await;
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit: Option<u32> = None;
    let mut truncated = false;
    let deadline = tokio::time::Instant::now() + opts.timeout;
    loop {
        let msg = match tokio::time::timeout_at(deadline, ch.wait()).await {
            Ok(m) => m,
            Err(_) => {
                let _ = ch.close().await;
                return Err(AppError::new(ErrorCode::ConnectionTimeout, "Command timed out", format!("The command did not finish within {}s.", opts.timeout.as_secs())));
            }
        };
        match msg {
            Some(ChannelMsg::Data { data }) => {
                if stdout.len() < opts.max_output {
                    let take = (opts.max_output - stdout.len()).min(data.len());
                    stdout.extend_from_slice(&data[..take]);
                    truncated |= take < data.len();
                } else {
                    truncated = true;
                }
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                if stderr.len() < 1024 * 1024 {
                    stderr.extend_from_slice(&data);
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok(ExecOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code: exit,
        duration_ms: started.elapsed().as_millis() as u64,
        truncated,
    })
}

/// Run and require exit code 0; `what` describes the action for errors.
pub async fn exec_ok(conn: &ServerConnection, command: &str, what: &str, opts: ExecOptions) -> Result<ExecOutput> {
    let out = exec(conn, command, opts).await?;
    if out.exit_code == Some(0) {
        Ok(out)
    } else {
        let msg = if out.stderr.trim().is_empty() { out.stdout.clone() } else { out.stderr.clone() };
        Err(AppError::command_failed(what, out.exit_code, &msg))
    }
}

/// Stream a long-running command's output as batches of lines until it ends
/// or `cancel` fires. A PTY is requested when `pty` is true so that closing
/// the channel reliably terminates followers like `tail -F` (SIGHUP).
pub async fn exec_stream(
    conn: &ServerConnection,
    command: &str,
    pty: bool,
    cancel: CancellationToken,
    on_event: StreamFn<StreamEvent>,
) -> Result<Option<u32>> {
    let handle = conn.handle()?;
    let mut ch = handle.channel_open_session().await.map_err(|e| humanize_russh(&e, &ctx(conn)))?;
    if pty {
        ch.request_pty(false, "dumb", 512, 50, 0, 0, &[]).await.map_err(|e| humanize_russh(&e, &ctx(conn)))?;
    }
    ch.exec(true, command.as_bytes()).await.map_err(|e| humanize_russh(&e, &ctx(conn)))?;

    let mut partial: Vec<u8> = Vec::new();
    let mut batch: Vec<String> = Vec::new();
    let mut exit = None;
    let flush_every = Duration::from_millis(100);
    let mut flush_at: Option<tokio::time::Instant> = None;

    let push_bytes = |data: &[u8], partial: &mut Vec<u8>, batch: &mut Vec<String>| {
        partial.extend_from_slice(data);
        while let Some(pos) = partial.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = partial.drain(..=pos).collect();
            let mut s = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
            if s.ends_with('\r') {
                s.pop();
            }
            batch.push(s);
        }
        // Guard against a never-ending line.
        if partial.len() > 64 * 1024 {
            batch.push(String::from_utf8_lossy(partial).into_owned());
            partial.clear();
        }
    };

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = ch.signal(russh::Sig::TERM).await;
                let _ = ch.close().await;
                break;
            }
            _ = async { tokio::time::sleep_until(flush_at.unwrap()).await }, if flush_at.is_some() => {
                if !batch.is_empty() {
                    on_event(StreamEvent::Lines { lines: std::mem::take(&mut batch) });
                }
                flush_at = None;
            }
            msg = ch.wait() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    push_bytes(&data, &mut partial, &mut batch);
                    if batch.len() >= 1000 {
                        on_event(StreamEvent::Lines { lines: std::mem::take(&mut batch) });
                        flush_at = None;
                    } else if !batch.is_empty() && flush_at.is_none() {
                        flush_at = Some(tokio::time::Instant::now() + flush_every);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
    }
    if !partial.is_empty() {
        batch.push(String::from_utf8_lossy(&partial).trim_end_matches('\r').to_string());
    }
    if !batch.is_empty() {
        on_event(StreamEvent::Lines { lines: batch });
    }
    on_event(StreamEvent::End { code: exit });
    Ok(exit)
}
