use crate::state::AppState;
use brainbox_core::model::*;
use brainbox_core::sftp::ops;
use brainbox_core::{filesystem, AppError, ErrorCode, Result};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

// ───────── remote (SFTP) ─────────

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, server_id: String) -> Result<String> {
    ops::home_dir(&*state.conns.require(&server_id)?).await
}

#[tauri::command]
pub async fn sftp_list(state: State<'_, AppState>, server_id: String, path: String) -> Result<DirListing> {
    ops::list_dir(&*state.conns.require(&server_id)?, &path).await
}

#[tauri::command]
pub async fn sftp_stat(state: State<'_, AppState>, server_id: String, path: String) -> Result<FileEntry> {
    ops::stat(&*state.conns.require(&server_id)?, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, AppState>, server_id: String, path: String) -> Result<()> {
    ops::mkdir(&*state.conns.require(&server_id)?, &path).await
}

#[tauri::command]
pub async fn sftp_create_file(state: State<'_, AppState>, server_id: String, path: String) -> Result<()> {
    ops::create_file(&*state.conns.require(&server_id)?, &path).await
}

#[tauri::command]
pub async fn sftp_rename(state: State<'_, AppState>, server_id: String, from: String, to: String) -> Result<()> {
    ops::rename(&*state.conns.require(&server_id)?, &from, &to).await
}

#[tauri::command]
pub async fn sftp_delete(state: State<'_, AppState>, server_id: String, paths: Vec<String>, confirmed: bool) -> Result<u32> {
    if !confirmed {
        return Err(AppError::confirmation_required("Deleting files"));
    }
    ops::delete(&*state.conns.require(&server_id)?, &paths).await
}

#[tauri::command]
pub async fn sftp_copy(state: State<'_, AppState>, server_id: String, from: String, to: String) -> Result<()> {
    ops::copy(&*state.conns.require(&server_id)?, &from, &to).await
}

#[tauri::command]
pub async fn sftp_move(state: State<'_, AppState>, server_id: String, paths: Vec<String>, to_dir: String) -> Result<Vec<String>> {
    let c = state.conns.require(&server_id)?;
    let mut out = Vec::new();
    for p in paths {
        out.push(ops::move_to(&c, &p, &to_dir).await?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn sftp_chmod(state: State<'_, AppState>, server_id: String, path: String, mode: u32) -> Result<()> {
    ops::chmod(&*state.conns.require(&server_id)?, &path, mode).await
}

#[tauri::command]
pub async fn sftp_read_text(state: State<'_, AppState>, server_id: String, path: String) -> Result<TextFile> {
    ops::read_text(&*state.conns.require(&server_id)?, &path).await
}

#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    content: String,
    encoding: String,
    expected_mtime: Option<i64>,
) -> Result<FileEntry> {
    ops::write_text(&*state.conns.require(&server_id)?, &path, &content, &encoding, expected_mtime).await
}

#[tauri::command]
pub async fn sftp_search(state: State<'_, AppState>, server_id: String, root: String, query: String) -> Result<Vec<FileEntry>> {
    ops::search(&*state.conns.require(&server_id)?, &root, &query, 500).await
}

#[tauri::command]
pub async fn sftp_dir_size(state: State<'_, AppState>, server_id: String, path: String) -> Result<u64> {
    ops::dir_size(&*state.conns.require(&server_id)?, &path).await
}

// ───────── local ─────────

#[tauri::command]
pub fn local_home() -> String {
    filesystem::home()
}

#[tauri::command]
pub async fn local_list(path: String) -> Result<DirListing> {
    tokio::task::spawn_blocking(move || filesystem::list(&path)).await?
}

#[tauri::command]
pub fn local_stat(path: String) -> Result<FileEntry> {
    filesystem::entry(std::path::Path::new(&path))
}

#[tauri::command]
pub fn local_mkdir(dir: String, name: String) -> Result<String> {
    filesystem::mkdir(&dir, &name)
}

#[tauri::command]
pub fn local_create_file(dir: String, name: String) -> Result<String> {
    filesystem::create_file(&dir, &name)
}

#[tauri::command]
pub fn local_rename(path: String, new_name: String) -> Result<String> {
    filesystem::rename(&path, &new_name)
}

#[tauri::command]
pub async fn local_delete(paths: Vec<String>, permanent: bool, confirmed: bool) -> Result<()> {
    if !confirmed {
        return Err(AppError::confirmation_required("Deleting files"));
    }
    tokio::task::spawn_blocking(move || filesystem::delete(&paths, permanent)).await?
}

#[tauri::command]
pub async fn local_copy(paths: Vec<String>, to_dir: String) -> Result<Vec<String>> {
    tokio::task::spawn_blocking(move || filesystem::copy(&paths, &to_dir)).await?
}

#[tauri::command]
pub async fn local_move(paths: Vec<String>, to_dir: String) -> Result<Vec<String>> {
    tokio::task::spawn_blocking(move || filesystem::move_to(&paths, &to_dir)).await?
}

#[tauri::command]
pub async fn local_search(root: String, query: String) -> Result<Vec<FileEntry>> {
    tokio::task::spawn_blocking(move || filesystem::search(&root, &query, 500)).await?
}

#[tauri::command]
pub fn local_open(app: tauri::AppHandle, path: String) -> Result<()> {
    if !std::path::Path::new(&path).exists() {
        return Err(AppError::new(ErrorCode::NotFound, "Not found", format!("\"{path}\" no longer exists.")));
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| AppError::new(ErrorCode::Io, "Cannot open", "Windows could not open this file.").details(e.to_string()))
}

#[tauri::command]
pub fn local_reveal(app: tauri::AppHandle, path: String) -> Result<()> {
    app.opener().reveal_item_in_dir(&path).map_err(|e| AppError::new(ErrorCode::Io, "Cannot show file", "Could not open the containing folder.").details(e.to_string()))
}

/// Open an http(s) link in the default browser (used for clickable terminal URLs).
#[tauri::command]
pub fn open_url(app: tauri::AppHandle, url: String) -> Result<()> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(AppError::invalid("Only http(s) links can be opened."));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| AppError::new(ErrorCode::Io, "Cannot open link", "The browser could not be opened.").details(e.to_string()))
}

// ───────── transfers ─────────

#[tauri::command]
pub fn transfer_start(state: State<'_, AppState>, req: TransferRequest) -> Result<TransferInfo> {
    state.transfers.enqueue(req)
}

#[tauri::command]
pub fn transfer_start_many(state: State<'_, AppState>, reqs: Vec<TransferRequest>) -> Result<Vec<TransferInfo>> {
    reqs.into_iter().map(|r| state.transfers.enqueue(r)).collect()
}

#[tauri::command]
pub fn transfers_list(state: State<'_, AppState>) -> Vec<TransferInfo> {
    state.transfers.list()
}

#[tauri::command]
pub fn transfer_pause(state: State<'_, AppState>, id: String) -> Result<()> {
    state.transfers.pause(&id)
}

#[tauri::command]
pub fn transfer_resume(state: State<'_, AppState>, id: String) -> Result<()> {
    state.transfers.resume(&id)
}

#[tauri::command]
pub fn transfer_retry(state: State<'_, AppState>, id: String) -> Result<()> {
    state.transfers.retry(&id)
}

#[tauri::command]
pub async fn transfer_cancel(state: State<'_, AppState>, id: String) -> Result<()> {
    state.transfers.cancel(&id).await
}

#[tauri::command]
pub fn transfers_clear_finished(state: State<'_, AppState>) {
    state.transfers.clear_finished()
}
