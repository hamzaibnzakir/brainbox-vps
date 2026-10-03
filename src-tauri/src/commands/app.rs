//! Tunnels, commands/snippets, broadcast, workspaces, settings, AI, app info.

use crate::state::AppState;
use brainbox_core::model::*;
use brainbox_core::security::policy::assess;
use brainbox_core::ssh::exec::{exec, ExecOptions};
use brainbox_core::{broadcast, AppError, Result};
use serde::Serialize;
use tauri::State;
use tauri_plugin_autostart::ManagerExt;

// ───────── Tunnels ─────────

#[tauri::command]
pub fn tunnels_list(state: State<'_, AppState>) -> Result<Vec<TunnelConfig>> {
    state.storage.list_tunnels()
}

#[tauri::command]
pub fn tunnel_statuses(state: State<'_, AppState>) -> Vec<TunnelStatus> {
    state.tunnels.statuses()
}

#[tauri::command]
pub async fn tunnel_save(state: State<'_, AppState>, id: Option<String>, input: TunnelInput) -> Result<TunnelConfig> {
    if let Some(i) = &id {
        // Restart a running tunnel so edits take effect.
        if state.tunnels.status(i).is_some() {
            state.tunnels.stop(i).await;
        }
    }
    state.storage.save_tunnel(id.as_deref(), &input)
}

#[tauri::command]
pub async fn tunnel_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.tunnels.stop(&id).await;
    state.storage.delete_tunnel(&id)
}

#[tauri::command]
pub async fn tunnel_start(state: State<'_, AppState>, id: String) -> Result<TunnelStatus> {
    state.tunnels.start(&id).await
}

#[tauri::command]
pub async fn tunnel_stop(state: State<'_, AppState>, id: String) -> Result<()> {
    state.tunnels.stop(&id).await;
    Ok(())
}

// ───────── Snippets ─────────

#[tauri::command]
pub fn snippets_list(state: State<'_, AppState>) -> Result<Vec<Snippet>> {
    state.storage.list_snippets()
}

#[tauri::command]
pub fn snippet_save(state: State<'_, AppState>, id: Option<String>, input: SnippetInput) -> Result<Snippet> {
    state.storage.save_snippet(id.as_deref(), &input)
}

#[tauri::command]
pub fn snippet_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.storage.delete_snippet(&id)
}

#[tauri::command]
pub fn command_assess(command: String) -> CommandAssessment {
    assess(&command)
}

/// Run a command non-interactively and return its output (Command Center "Run & capture").
#[tauri::command]
pub async fn command_run(state: State<'_, AppState>, server_id: String, command: String, confirmed: bool) -> Result<ExecOutput> {
    let a = assess(&command);
    if a.risk >= CommandRisk::Mutating && !confirmed {
        let mut e = AppError::confirmation_required("This command");
        e.causes = a.reasons;
        return Err(e);
    }
    let c = state.conns.require(&server_id)?;
    let out = exec(&c, &command, ExecOptions::timeout(1800)).await?;
    let settings = state.storage.settings()?;
    if out.duration_ms >= settings.notifications.min_duration_secs as u64 * 1000 {
        state.sink.emit_json(
            brainbox_core::events::names::NOTIFY,
            serde_json::to_value(AppNotification {
                kind: "command_finished".into(),
                title: format!("Command finished on {}", c.profile().name),
                body: format!("{} (exit {})", command.chars().take(80).collect::<String>(), out.exit_code.map(|c| c.to_string()).unwrap_or("?".into())),
                server_id: Some(server_id),
            })
            .unwrap_or_default(),
        );
    }
    Ok(out)
}

// ───────── Broadcast ─────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastRun {
    pub broadcast_id: String,
    pub results: Vec<BroadcastResult>,
}

#[tauri::command]
pub async fn broadcast_run(state: State<'_, AppState>, server_ids: Vec<String>, command: String, confirmed: bool) -> Result<BroadcastRun> {
    let (id, results) = broadcast::run(&state.conns, &state.sink, &server_ids, &command, confirmed, 1800).await?;
    Ok(BroadcastRun { broadcast_id: id, results })
}

// ───────── Workspaces & UI state ─────────

#[tauri::command]
pub fn workspaces_list(state: State<'_, AppState>) -> Result<Vec<Workspace>> {
    state.storage.list_workspaces()
}

#[tauri::command]
pub fn workspace_create(state: State<'_, AppState>, name: String, server_ids: Vec<String>) -> Result<Workspace> {
    state.storage.create_workspace(&name, server_ids)
}

#[tauri::command]
pub fn workspace_save(state: State<'_, AppState>, workspace: Workspace) -> Result<Workspace> {
    state.storage.save_workspace(&workspace)
}

#[tauri::command]
pub fn workspace_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.storage.delete_workspace(&id)
}

#[tauri::command]
pub fn ui_state_get(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    state.storage.kv_get(&format!("ui:{key}"))
}

#[tauri::command]
pub fn ui_state_set(state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    state.storage.kv_set(&format!("ui:{key}"), &value)
}

// ───────── Settings ─────────

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<Settings> {
    state.storage.settings()
}

#[tauri::command]
pub fn settings_save(app: tauri::AppHandle, state: State<'_, AppState>, settings: Settings) -> Result<Settings> {
    let prev = state.storage.settings()?;
    let saved = state.storage.save_settings(&settings)?;
    if prev.transfer_concurrency != saved.transfer_concurrency {
        state.transfers.set_concurrency(saved.transfer_concurrency as usize);
    }
    state.transfers.set_min_notify_secs(saved.notifications.min_duration_secs as u64);
    if prev.launch_at_startup != saved.launch_at_startup {
        let al = app.autolaunch();
        let r = if saved.launch_at_startup { al.enable() } else { al.disable() };
        if let Err(e) = r {
            log::warn!("autostart change failed: {e}");
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn ai_set_key(state: State<'_, AppState>, key: Option<String>) -> Result<Settings> {
    state.storage.set_ai_key(key.as_deref())?;
    state.storage.settings()
}

#[tauri::command]
pub fn ai_new_chat(state: State<'_, AppState>, server_id: String) -> Result<String> {
    state.ai.new_chat(&server_id)
}

#[tauri::command]
pub async fn ai_send(state: State<'_, AppState>, chat_id: String, text: String) -> Result<AiTurnResult> {
    state.ai.send(&chat_id, &text).await
}

#[tauri::command]
pub async fn ai_decide(state: State<'_, AppState>, chat_id: String, proposal_id: String, approve: bool) -> Result<AiTurnResult> {
    state.ai.decide(&chat_id, &proposal_id, approve).await
}

#[tauri::command]
pub fn ai_delete_chat(state: State<'_, AppState>, chat_id: String) {
    state.ai.delete_chat(&chat_id)
}

// ───────── App ─────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub vault_backend: String,
    pub platform: String,
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.to_string_lossy().to_string(),
        vault_backend: state.vault_backend.to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
pub async fn app_quit(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<()> {
    state.shutdown().await;
    app.exit(0);
    Ok(())
}
