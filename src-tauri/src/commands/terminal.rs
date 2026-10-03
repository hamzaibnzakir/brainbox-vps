use crate::state::AppState;
use brainbox_core::events::StreamFn;
use brainbox_core::model::*;
use brainbox_core::ssh::exec::{exec, ExecOptions};
use brainbox_core::terminal::local::detect_shells;
use brainbox_core::Result;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

fn sink(ch: Channel<TerminalEvent>) -> StreamFn<TerminalEvent> {
    Arc::new(move |ev| {
        let _ = ch.send(ev);
    })
}

#[tauri::command]
pub async fn terminal_open(state: State<'_, AppState>, req: TerminalOpenRequest, on_event: Channel<TerminalEvent>) -> Result<TerminalInfo> {
    state.terminals.open_remote(req, sink(on_event)).await
}

#[tauri::command]
pub fn terminal_open_local(
    state: State<'_, AppState>,
    shell_id: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalInfo> {
    state.terminals.open_local(shell_id.as_deref(), cols, rows, cwd.as_deref(), sink(on_event))
}

/// `binary` = data is a "binary string" from xterm's onBinary (one char per byte).
#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, id: String, data: String, binary: Option<bool>) -> Result<()> {
    if binary.unwrap_or(false) {
        let bytes: Vec<u8> = data.chars().map(|c| c as u32 as u8).collect();
        state.terminals.write(&id, &bytes)
    } else {
        state.terminals.write(&id, data.as_bytes())
    }
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, id: String, cols: u32, rows: u32) -> Result<()> {
    state.terminals.resize(&id, cols, rows)
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, id: String) {
    state.terminals.close(&id)
}

#[tauri::command]
pub fn local_shells() -> Vec<LocalShellInfo> {
    detect_shells()
}

/// Existing tmux sessions on the server (for re-attaching after a restart).
#[tauri::command]
pub async fn tmux_sessions(state: State<'_, AppState>, server_id: String) -> Result<Vec<String>> {
    let c = state.conns.require(&server_id)?;
    let out = exec(&c, "tmux list-sessions -F '#{session_name}' 2>/dev/null", ExecOptions::timeout(15)).await?;
    Ok(out.stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}
