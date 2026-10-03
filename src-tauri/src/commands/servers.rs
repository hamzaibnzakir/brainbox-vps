use crate::state::AppState;
use brainbox_core::model::*;
use brainbox_core::security::SecretString;
use brainbox_core::ssh::auth::Credentials;
use brainbox_core::storage::SecretKind;
use brainbox_core::{sshconfig, AppError, Result};
use std::path::Path;
use tauri::State;

#[tauri::command]
pub fn servers_list(state: State<'_, AppState>) -> Result<Vec<ServerProfile>> {
    state.storage.list_servers()
}

#[tauri::command]
pub fn server_create(state: State<'_, AppState>, input: ServerInput) -> Result<ServerProfile> {
    state.storage.create_server(&input)
}

#[tauri::command]
pub fn server_update(state: State<'_, AppState>, id: String, input: ServerInput) -> Result<ServerProfile> {
    state.storage.update_server(&id, &input)
}

#[tauri::command]
pub async fn server_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    for t in state.storage.list_tunnels()?.into_iter().filter(|t| t.server_id == id) {
        state.tunnels.stop(&t.id).await;
    }
    state.monitor.stop(&id);
    state.conns.remove(&id).await;
    state.storage.delete_server(&id)
}

#[tauri::command]
pub fn server_duplicate(state: State<'_, AppState>, id: String) -> Result<ServerProfile> {
    state.storage.duplicate_server(&id)
}

#[tauri::command]
pub fn server_set_favorite(state: State<'_, AppState>, id: String, favorite: bool) -> Result<ServerProfile> {
    state.storage.patch_server(&id, |s| s.favorite = favorite)
}

#[tauri::command]
pub fn server_rename(state: State<'_, AppState>, id: String, name: String) -> Result<ServerProfile> {
    if name.trim().is_empty() {
        return Err(AppError::invalid("Give the server a name."));
    }
    state.storage.patch_server(&id, |s| s.name = name.trim().to_string())
}

#[tauri::command]
pub fn servers_set_group(state: State<'_, AppState>, ids: Vec<String>, group: Option<String>) -> Result<()> {
    let g = group.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
    for id in ids {
        state.storage.patch_server(&id, |s| s.group = g.clone())?;
    }
    Ok(())
}

#[tauri::command]
pub fn servers_reorder(state: State<'_, AppState>, ids: Vec<String>) -> Result<()> {
    state.storage.reorder_servers(&ids)
}

#[tauri::command]
pub fn ssh_config_scan(state: State<'_, AppState>) -> Result<Vec<SshConfigHost>> {
    let existing = state.storage.list_servers()?;
    Ok(sshconfig::read_default()
        .into_iter()
        .map(|mut h| {
            h.already_imported = existing.iter().any(|s| s.host == h.host && s.port == h.port && Some(&s.username) == h.username.as_ref());
            h
        })
        .collect())
}

fn default_identity() -> Option<String> {
    let home = dirs::home_dir()?;
    ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| home.join(".ssh").join(n)).find(|p| p.exists()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ssh_config_import(state: State<'_, AppState>, hosts: Vec<SshConfigHost>) -> Result<Vec<ServerProfile>> {
    let mut created: Vec<(String, ServerProfile, Option<String>)> = Vec::new();
    for h in &hosts {
        let identity = h.identity_file.clone().filter(|p| Path::new(p).exists()).or_else(default_identity);
        let input = ServerInput {
            name: h.alias.clone(),
            host: h.host.clone(),
            port: h.port,
            username: h.username.clone().unwrap_or_else(|| std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "root".into())),
            auth_method: if identity.is_some() { AuthMethod::Key } else { AuthMethod::Password },
            key_path: identity,
            password: SecretUpdate::Keep,
            passphrase: SecretUpdate::Keep,
            key_data: SecretUpdate::Keep,
            group: Some("Imported".into()),
            tags: vec!["ssh-config".into()],
            favorite: false,
            color: None,
            notes: None,
            proxy: None,
            proxy_password: SecretUpdate::Keep,
            jump_host_id: None,
            keepalive_secs: 30,
            connect_timeout_secs: 15,
            auto_reconnect: true,
            use_tmux: false,
            startup_dir: None,
            startup_command: None,
        };
        let p = state.storage.create_server(&input)?;
        created.push((h.alias.clone(), p, h.proxy_jump.clone()));
    }
    // Resolve ProxyJump aliases to imported/existing servers.
    let all = state.storage.list_servers()?;
    let mut out = Vec::new();
    for (_, p, jump) in created {
        let mut p = p;
        if let Some(j) = jump {
            let first = j.split(',').next().unwrap_or("").split('@').next_back().unwrap_or("");
            if let Some(js) = all.iter().find(|s| s.name == first || s.host == first) {
                if js.id != p.id {
                    p = state.storage.patch_server(&p.id, |s| s.jump_host_id = Some(js.id.clone()))?;
                }
            }
        }
        out.push(p);
    }
    Ok(out)
}

#[tauri::command]
pub fn known_hosts_list(state: State<'_, AppState>) -> Result<Vec<KnownHost>> {
    state.storage.list_known_hosts()
}

#[tauri::command]
pub fn known_host_forget(state: State<'_, AppState>, host: String, port: u16) -> Result<()> {
    state.storage.forget_host(&host, port)
}

// ───────── connections ─────────

#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    server_id: String,
    password: Option<String>,
    passphrase: Option<String>,
    save: Option<bool>,
) -> Result<ConnectionStatus> {
    let creds = if password.is_some() || passphrase.is_some() {
        Some(Credentials {
            password: password.clone().map(SecretString::new),
            passphrase: passphrase.clone().map(SecretString::new),
            ..Default::default()
        })
    } else {
        None
    };
    let st = state.conns.connect(&server_id, creds).await?;
    if save.unwrap_or(false) {
        if let Some(pw) = password {
            state.storage.set_secret(&server_id, SecretKind::Password, &SecretString::new(pw))?;
            state.storage.patch_server(&server_id, |s| s.has_password = true)?;
        }
        if let Some(pp) = passphrase {
            state.storage.set_secret(&server_id, SecretKind::Passphrase, &SecretString::new(pp))?;
            state.storage.patch_server(&server_id, |s| s.has_passphrase = true)?;
        }
    }
    Ok(st)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, server_id: String) -> Result<()> {
    state.monitor.stop(&server_id);
    state.conns.disconnect(&server_id).await;
    state.sudo.clear(&server_id);
    Ok(())
}

#[tauri::command]
pub fn connection_statuses(state: State<'_, AppState>) -> Vec<ConnectionStatus> {
    state.conns.statuses()
}

#[tauri::command]
pub fn host_key_answer(state: State<'_, AppState>, request_id: String, decision: HostKeyDecision) -> bool {
    state.prompts.answer(&request_id, decision)
}

#[tauri::command]
pub fn host_key_pending(state: State<'_, AppState>) -> Vec<HostKeyPrompt> {
    state.prompts.pending()
}
