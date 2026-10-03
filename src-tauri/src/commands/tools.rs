//! Monitoring, processes, ports, services, Docker, Git, logs.

use crate::state::AppState;
use brainbox_core::events::StreamFn;
use brainbox_core::model::*;
use brainbox_core::security::SecretString;
use brainbox_core::{docker, git, logs, monitoring, Result};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
pub fn monitor_start(state: State<'_, AppState>, server_id: String, interval_ms: u32) {
    state.monitor.start(&server_id, interval_ms)
}

#[tauri::command]
pub fn monitor_stop(state: State<'_, AppState>, server_id: String) {
    state.monitor.stop(&server_id)
}

#[tauri::command]
pub fn monitor_history(state: State<'_, AppState>, server_id: String) -> Vec<MetricsSnapshot> {
    state.monitor.history(&server_id)
}

#[tauri::command]
pub async fn system_info(state: State<'_, AppState>, server_id: String) -> Result<SystemInfo> {
    monitoring::system_info(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn processes_list(state: State<'_, AppState>, server_id: String) -> Result<Vec<ProcessInfo>> {
    monitoring::list_processes(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn process_details(state: State<'_, AppState>, server_id: String, pid: u32) -> Result<String> {
    monitoring::process_details(&*state.conns.require(&server_id)?, pid).await
}

#[tauri::command]
pub async fn process_signal(state: State<'_, AppState>, server_id: String, pid: u32, signal: Signal, confirmed: bool, sudo_password: Option<String>) -> Result<()> {
    let c = state.conns.require(&server_id)?;
    monitoring::signal_process(&c, &state.sudo, pid, signal, confirmed, sudo_password.map(SecretString::new)).await
}

#[tauri::command]
pub async fn ports_list(state: State<'_, AppState>, server_id: String) -> Result<Vec<PortInfo>> {
    monitoring::list_ports(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn services_list(state: State<'_, AppState>, server_id: String) -> Result<Vec<ServiceInfo>> {
    monitoring::list_services(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn service_status(state: State<'_, AppState>, server_id: String, unit: String) -> Result<String> {
    monitoring::service_status(&*state.conns.require(&server_id)?, &unit).await
}

#[tauri::command]
pub async fn service_action(state: State<'_, AppState>, server_id: String, unit: String, action: ServiceAction, confirmed: bool, sudo_password: Option<String>) -> Result<()> {
    let c = state.conns.require(&server_id)?;
    monitoring::service_action(&c, &state.sudo, &unit, action, confirmed, sudo_password.map(SecretString::new)).await
}

// ───────── Docker ─────────

#[tauri::command]
pub async fn docker_status(state: State<'_, AppState>, server_id: String, refresh: bool) -> Result<DockerStatus> {
    docker::status(&*state.conns.require(&server_id)?, refresh).await
}

#[tauri::command]
pub async fn docker_containers(state: State<'_, AppState>, server_id: String) -> Result<Vec<DockerContainer>> {
    docker::containers(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn docker_images(state: State<'_, AppState>, server_id: String) -> Result<Vec<DockerImage>> {
    docker::images(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn docker_volumes(state: State<'_, AppState>, server_id: String) -> Result<Vec<DockerVolume>> {
    docker::volumes(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn docker_networks(state: State<'_, AppState>, server_id: String) -> Result<Vec<DockerNetwork>> {
    docker::networks(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn docker_stats(state: State<'_, AppState>, server_id: String) -> Result<Vec<DockerStats>> {
    docker::stats(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn docker_inspect(state: State<'_, AppState>, server_id: String, id: String) -> Result<String> {
    docker::inspect(&*state.conns.require(&server_id)?, &id).await
}

#[tauri::command]
pub async fn docker_container_action(state: State<'_, AppState>, server_id: String, id: String, action: ContainerAction, confirmed: bool) -> Result<()> {
    docker::container_action(&*state.conns.require(&server_id)?, &id, action, confirmed).await
}

#[tauri::command]
pub async fn docker_remove_image(state: State<'_, AppState>, server_id: String, id: String, confirmed: bool) -> Result<()> {
    docker::remove_image(&*state.conns.require(&server_id)?, &id, confirmed).await
}

#[tauri::command]
pub async fn docker_remove_volume(state: State<'_, AppState>, server_id: String, name: String, confirmed: bool) -> Result<()> {
    docker::remove_volume(&*state.conns.require(&server_id)?, &name, confirmed).await
}

#[tauri::command]
pub async fn docker_exec_command(state: State<'_, AppState>, server_id: String, id: String) -> Result<String> {
    docker::exec_shell_command(&*state.conns.require(&server_id)?, &id).await
}

// ───────── Git ─────────

#[tauri::command]
pub async fn git_discover(state: State<'_, AppState>, server_id: String, root: Option<String>) -> Result<Vec<String>> {
    git::discover(&*state.conns.require(&server_id)?, root.as_deref()).await
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>, server_id: String, repo: String) -> Result<GitStatus> {
    git::status(&*state.conns.require(&server_id)?, &repo).await
}

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>, server_id: String, repo: String) -> Result<Vec<GitBranch>> {
    git::branches(&*state.conns.require(&server_id)?, &repo).await
}

#[tauri::command]
pub async fn git_log(state: State<'_, AppState>, server_id: String, repo: String, limit: u32, file: Option<String>) -> Result<Vec<GitCommit>> {
    git::log(&*state.conns.require(&server_id)?, &repo, limit, file.as_deref()).await
}

#[tauri::command]
pub async fn git_diff(state: State<'_, AppState>, server_id: String, repo: String, file: Option<String>, staged: bool) -> Result<String> {
    git::diff(&*state.conns.require(&server_id)?, &repo, file.as_deref(), staged).await
}

#[tauri::command]
pub async fn git_show(state: State<'_, AppState>, server_id: String, repo: String, hash: String) -> Result<String> {
    git::show(&*state.conns.require(&server_id)?, &repo, &hash).await
}

#[tauri::command]
pub async fn git_action(state: State<'_, AppState>, server_id: String, repo: String, action: GitAction, confirmed: bool) -> Result<String> {
    git::action(&*state.conns.require(&server_id)?, &repo, action, confirmed).await
}

#[tauri::command]
pub async fn git_checkout(state: State<'_, AppState>, server_id: String, repo: String, branch: String, confirmed: bool) -> Result<String> {
    git::checkout(&*state.conns.require(&server_id)?, &repo, &branch, confirmed).await
}

// ───────── Logs ─────────

#[tauri::command]
pub async fn logs_start(state: State<'_, AppState>, req: LogStreamRequest, on_event: Channel<StreamEvent>) -> Result<String> {
    let sink: StreamFn<StreamEvent> = Arc::new(move |ev| {
        let _ = on_event.send(ev);
    });
    state.logs.start(req, sink).await
}

#[tauri::command]
pub fn logs_stop(state: State<'_, AppState>, id: String) {
    state.logs.stop(&id)
}

#[tauri::command]
pub async fn logs_discover(state: State<'_, AppState>, server_id: String) -> Result<Vec<LogFileCandidate>> {
    logs::discover_files(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn logs_export(state: State<'_, AppState>, server_id: String, source: LogSource, sudo: bool, local_path: String) -> Result<u64> {
    logs::export(&*state.conns.require(&server_id)?, &state.sudo, &source, sudo, &local_path).await
}

#[tauri::command]
pub fn sudo_remember(state: State<'_, AppState>, server_id: String, password: String) {
    state.sudo.set(&server_id, SecretString::new(password));
}
