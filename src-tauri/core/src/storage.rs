//! SQLite persistence for profiles, snippets, tunnels, workspaces, settings,
//! known hosts and encrypted secrets.

use crate::error::{AppError, ErrorCode, Result};
use crate::model::*;
use crate::security::{SecretString, Vault};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;
use std::sync::Arc;

const SCHEMA_VERSION: i64 = 1;

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE IF NOT EXISTS servers   (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snippets  (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tunnels   (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secrets   (id TEXT PRIMARY KEY, blob TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv        (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS known_hosts(
    host TEXT NOT NULL, port INTEGER NOT NULL, algorithm TEXT NOT NULL,
    fingerprint TEXT NOT NULL, added_at INTEGER NOT NULL,
    PRIMARY KEY (host, port, algorithm)
);
"#];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    Password,
    Passphrase,
    KeyData,
    ProxyPassword,
}

impl SecretKind {
    fn suffix(self) -> &'static str {
        match self {
            SecretKind::Password => "password",
            SecretKind::Passphrase => "passphrase",
            SecretKind::KeyData => "key",
            SecretKind::ProxyPassword => "proxy_password",
        }
    }
}

pub const AI_KEY_ID: &str = "global:ai_api_key";

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub struct Storage {
    conn: Mutex<Connection>,
    vault: Arc<Vault>,
}

impl std::fmt::Debug for Storage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Storage")
    }
}

impl Storage {
    pub fn open(path: &Path, vault: Arc<Vault>) -> Result<Self> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(AppError::storage)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn, vault)
    }

    pub fn in_memory(vault: Arc<Vault>) -> Result<Self> {
        Self::init(Connection::open_in_memory()?, vault)
    }

    fn init(conn: Connection, vault: Arc<Vault>) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, m) in MIGRATIONS.iter().enumerate() {
            if (i as i64) >= version {
                conn.execute_batch(m)?;
            }
        }
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Self { conn: Mutex::new(conn), vault })
    }

    pub fn vault(&self) -> &Arc<Vault> {
        &self.vault
    }

    // ───────── generic JSON documents ─────────

    fn doc_list<T: DeserializeOwned>(&self, table: &str) -> Result<Vec<T>> {
        let conn = self.conn.lock();
        let mut st = conn.prepare(&format!("SELECT data FROM {table}"))?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            match serde_json::from_str(&row?) {
                Ok(v) => out.push(v),
                Err(e) => log::warn!("skipping unreadable {table} row: {e}"),
            }
        }
        Ok(out)
    }

    fn doc_get<T: DeserializeOwned>(&self, table: &str, id: &str) -> Result<Option<T>> {
        let conn = self.conn.lock();
        let s: Option<String> = conn
            .query_row(&format!("SELECT data FROM {table} WHERE id = ?1"), [id], |r| r.get(0))
            .optional()?;
        Ok(match s {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        })
    }

    fn doc_put<T: Serialize>(&self, table: &str, id: &str, v: &T) -> Result<()> {
        let data = serde_json::to_string(v)?;
        self.conn.lock().execute(
            &format!("INSERT INTO {table}(id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data"),
            params![id, data],
        )?;
        Ok(())
    }

    fn doc_delete(&self, table: &str, id: &str) -> Result<bool> {
        Ok(self.conn.lock().execute(&format!("DELETE FROM {table} WHERE id = ?1"), [id])? > 0)
    }

    // ───────── secrets ─────────

    fn secret_id(owner: &str, kind: SecretKind) -> String {
        format!("{owner}:{}", kind.suffix())
    }

    pub fn put_secret_raw(&self, id: &str, value: &SecretString) -> Result<()> {
        let blob = self.vault.seal_str(value, id)?;
        self.conn.lock().execute(
            "INSERT INTO secrets(id, blob) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET blob = excluded.blob",
            params![id, blob],
        )?;
        Ok(())
    }

    pub fn get_secret_raw(&self, id: &str) -> Result<Option<SecretString>> {
        let blob: Option<String> =
            self.conn.lock().query_row("SELECT blob FROM secrets WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        match blob {
            Some(b) => Ok(Some(self.vault.unseal_str(&b, id)?)),
            None => Ok(None),
        }
    }

    pub fn delete_secret_raw(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM secrets WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn set_secret(&self, owner: &str, kind: SecretKind, value: &SecretString) -> Result<()> {
        self.put_secret_raw(&Self::secret_id(owner, kind), value)
    }

    pub fn get_secret(&self, owner: &str, kind: SecretKind) -> Result<Option<SecretString>> {
        self.get_secret_raw(&Self::secret_id(owner, kind))
    }

    fn apply_secret(&self, owner: &str, kind: SecretKind, upd: &SecretUpdate, current: bool) -> Result<bool> {
        let id = Self::secret_id(owner, kind);
        match upd {
            SecretUpdate::Keep => Ok(current),
            SecretUpdate::Clear => {
                self.delete_secret_raw(&id)?;
                Ok(false)
            }
            SecretUpdate::Set(v) if v.is_empty() => {
                self.delete_secret_raw(&id)?;
                Ok(false)
            }
            SecretUpdate::Set(v) => {
                self.put_secret_raw(&id, &SecretString::new(v.clone()))?;
                Ok(true)
            }
        }
    }

    // ───────── servers ─────────

    pub fn list_servers(&self) -> Result<Vec<ServerProfile>> {
        let mut v: Vec<ServerProfile> = self.doc_list("servers")?;
        v.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(v)
    }

    pub fn get_server(&self, id: &str) -> Result<ServerProfile> {
        self.doc_get("servers", id)?.ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "Server not found", "This server no longer exists. It may have been deleted.")
        })
    }

    fn validate_server(input: &ServerInput, self_id: Option<&str>) -> Result<()> {
        if input.name.trim().is_empty() {
            return Err(AppError::invalid("Give the server a name."));
        }
        if input.host.trim().is_empty() {
            return Err(AppError::invalid("Enter a hostname or IP address."));
        }
        if input.host.trim().contains(char::is_whitespace) {
            return Err(AppError::invalid("The hostname cannot contain spaces."));
        }
        if input.username.trim().is_empty() {
            return Err(AppError::invalid("Enter the SSH username."));
        }
        if input.port == 0 {
            return Err(AppError::invalid("Port must be between 1 and 65535."));
        }
        if let (Some(j), Some(me)) = (&input.jump_host_id, self_id) {
            if j == me {
                return Err(AppError::invalid("A server cannot be its own jump host."));
            }
        }
        if let Some(p) = &input.proxy {
            if p.host.trim().is_empty() || p.port == 0 {
                return Err(AppError::invalid("Enter the proxy host and port."));
            }
        }
        Ok(())
    }

    fn build_profile(&self, id: String, input: &ServerInput, prev: Option<&ServerProfile>) -> Result<ServerProfile> {
        let has_password = self.apply_secret(&id, SecretKind::Password, &input.password, prev.is_some_and(|p| p.has_password))?;
        let has_passphrase =
            self.apply_secret(&id, SecretKind::Passphrase, &input.passphrase, prev.is_some_and(|p| p.has_passphrase))?;
        if let SecretUpdate::Set(k) = &input.key_data {
            if !k.trim().is_empty() {
                // Validate the key parses (with the passphrase if given) before storing.
                let pass = match &input.passphrase {
                    SecretUpdate::Set(p) if !p.is_empty() => Some(p.clone()),
                    SecretUpdate::Keep => self.get_secret(&id, SecretKind::Passphrase)?.map(|s| s.expose().to_string()),
                    _ => None,
                };
                if let Err(e) = russh::keys::decode_secret_key(k.trim(), pass.as_deref()) {
                    let msg = e.to_string();
                    if msg.to_lowercase().contains("encrypt") || msg.to_lowercase().contains("passphrase") {
                        return Err(AppError::new(
                            ErrorCode::NeedPassphrase,
                            "Key needs a passphrase",
                            "This private key is protected. Enter its passphrase.",
                        )
                        .details(msg));
                    }
                    return Err(AppError::new(ErrorCode::KeyLoadFailed, "Invalid private key", "The private key could not be read.")
                        .causes(["Paste the full key including the BEGIN/END lines", "PuTTY .ppk keys must be converted to OpenSSH format"])
                        .details(msg));
                }
            }
        }
        let has_key_data = self.apply_secret(&id, SecretKind::KeyData, &input.key_data, prev.is_some_and(|p| p.has_key_data))?;
        let proxy = match &input.proxy {
            Some(p) => {
                let had = prev.and_then(|x| x.proxy.as_ref()).is_some_and(|x| x.has_password);
                let has = self.apply_secret(&id, SecretKind::ProxyPassword, &input.proxy_password, had)?;
                Some(ProxyConfig { has_password: has, ..p.clone() })
            }
            None => {
                self.delete_secret_raw(&Self::secret_id(&id, SecretKind::ProxyPassword))?;
                None
            }
        };
        let ts = now();
        let mut tags: Vec<String> = input.tags.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        tags.sort();
        tags.dedup();
        Ok(ServerProfile {
            id,
            name: input.name.trim().to_string(),
            host: input.host.trim().to_string(),
            port: input.port,
            username: input.username.trim().to_string(),
            auth_method: input.auth_method,
            key_path: input.key_path.clone().filter(|s| !s.trim().is_empty()),
            has_password,
            has_passphrase,
            has_key_data,
            group: input.group.clone().map(|g| g.trim().to_string()).filter(|g| !g.is_empty()),
            tags,
            favorite: input.favorite,
            color: input.color.clone(),
            notes: input.notes.clone(),
            proxy,
            jump_host_id: input.jump_host_id.clone().filter(|s| !s.is_empty()),
            keepalive_secs: input.keepalive_secs,
            connect_timeout_secs: input.connect_timeout_secs.max(3),
            auto_reconnect: input.auto_reconnect,
            use_tmux: input.use_tmux,
            startup_dir: input.startup_dir.clone().filter(|s| !s.trim().is_empty()),
            startup_command: input.startup_command.clone().filter(|s| !s.trim().is_empty()),
            sort_order: prev.map(|p| p.sort_order).unwrap_or_else(|| ts),
            created_at: prev.map(|p| p.created_at).unwrap_or(ts),
            updated_at: ts,
            last_connected_at: prev.and_then(|p| p.last_connected_at),
        })
    }

    pub fn create_server(&self, input: &ServerInput) -> Result<ServerProfile> {
        Self::validate_server(input, None)?;
        let id = uuid::Uuid::new_v4().to_string();
        let p = self.build_profile(id, input, None)?;
        self.doc_put("servers", &p.id, &p)?;
        Ok(p)
    }

    pub fn update_server(&self, id: &str, input: &ServerInput) -> Result<ServerProfile> {
        Self::validate_server(input, Some(id))?;
        let prev = self.get_server(id)?;
        let p = self.build_profile(id.to_string(), input, Some(&prev))?;
        self.doc_put("servers", id, &p)?;
        Ok(p)
    }

    pub fn put_server(&self, p: &ServerProfile) -> Result<()> {
        self.doc_put("servers", &p.id, p)
    }

    pub fn delete_server(&self, id: &str) -> Result<()> {
        self.doc_delete("servers", id)?;
        for k in [SecretKind::Password, SecretKind::Passphrase, SecretKind::KeyData, SecretKind::ProxyPassword] {
            self.delete_secret_raw(&Self::secret_id(id, k))?;
        }
        for t in self.list_tunnels()?.into_iter().filter(|t| t.server_id == id) {
            self.doc_delete("tunnels", &t.id)?;
        }
        for s in self.list_snippets()?.into_iter().filter(|s| s.server_id.as_deref() == Some(id)) {
            self.doc_delete("snippets", &s.id)?;
        }
        // Clear dangling jump-host references.
        for mut s in self.list_servers()? {
            if s.jump_host_id.as_deref() == Some(id) {
                s.jump_host_id = None;
                self.put_server(&s)?;
            }
        }
        Ok(())
    }

    /// Copy a server, including its encrypted secrets (re-sealed under the new id).
    pub fn duplicate_server(&self, id: &str) -> Result<ServerProfile> {
        let src = self.get_server(id)?;
        let new_id = uuid::Uuid::new_v4().to_string();
        for k in [SecretKind::Password, SecretKind::Passphrase, SecretKind::KeyData, SecretKind::ProxyPassword] {
            if let Some(s) = self.get_secret(id, k)? {
                self.put_secret_raw(&Self::secret_id(&new_id, k), &s)?;
            }
        }
        let ts = now();
        let copy = ServerProfile {
            id: new_id,
            name: format!("{} (copy)", src.name),
            created_at: ts,
            updated_at: ts,
            last_connected_at: None,
            sort_order: src.sort_order + 1,
            ..src
        };
        self.put_server(&copy)?;
        Ok(copy)
    }

    pub fn patch_server<F: FnOnce(&mut ServerProfile)>(&self, id: &str, f: F) -> Result<ServerProfile> {
        let mut s = self.get_server(id)?;
        f(&mut s);
        s.updated_at = now();
        self.put_server(&s)?;
        Ok(s)
    }

    pub fn reorder_servers(&self, ids: &[String]) -> Result<()> {
        for (i, id) in ids.iter().enumerate() {
            if let Some(mut s) = self.doc_get::<ServerProfile>("servers", id)? {
                s.sort_order = i as i64;
                self.put_server(&s)?;
            }
        }
        Ok(())
    }

    // ───────── known hosts ─────────

    pub fn known_host_keys(&self, host: &str, port: u16) -> Result<Vec<KnownHost>> {
        let conn = self.conn.lock();
        let mut st = conn.prepare(
            "SELECT host, port, algorithm, fingerprint, added_at FROM known_hosts WHERE host = ?1 AND port = ?2",
        )?;
        let rows = st.query_map(params![host, port], |r| {
            Ok(KnownHost { host: r.get(0)?, port: r.get(1)?, algorithm: r.get(2)?, fingerprint: r.get(3)?, added_at: r.get(4)? })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn list_known_hosts(&self) -> Result<Vec<KnownHost>> {
        let conn = self.conn.lock();
        let mut st = conn.prepare("SELECT host, port, algorithm, fingerprint, added_at FROM known_hosts ORDER BY host, port")?;
        let rows = st.query_map([], |r| {
            Ok(KnownHost { host: r.get(0)?, port: r.get(1)?, algorithm: r.get(2)?, fingerprint: r.get(3)?, added_at: r.get(4)? })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Trust a key. Replaces every previously trusted key for that host:port so
    /// a changed key does not leave the old one behind.
    pub fn trust_host_key(&self, host: &str, port: u16, algorithm: &str, fingerprint: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM known_hosts WHERE host = ?1 AND port = ?2 AND algorithm = ?3", params![host, port, algorithm])?;
        conn.execute(
            "INSERT INTO known_hosts(host, port, algorithm, fingerprint, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![host, port, algorithm, fingerprint, now()],
        )?;
        Ok(())
    }

    pub fn forget_host(&self, host: &str, port: u16) -> Result<()> {
        self.conn.lock().execute("DELETE FROM known_hosts WHERE host = ?1 AND port = ?2", params![host, port])?;
        Ok(())
    }

    // ───────── snippets ─────────

    pub fn list_snippets(&self) -> Result<Vec<Snippet>> {
        let mut v: Vec<Snippet> = self.doc_list("snippets")?;
        v.sort_by(|a, b| a.category.cmp(&b.category).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(v)
    }

    pub fn save_snippet(&self, id: Option<&str>, input: &SnippetInput) -> Result<Snippet> {
        if input.name.trim().is_empty() || input.command.trim().is_empty() {
            return Err(AppError::invalid("A command needs a name and the command text."));
        }
        let ts = now();
        let prev = match id {
            Some(i) => self.doc_get::<Snippet>("snippets", i)?,
            None => None,
        };
        let s = Snippet {
            id: id.map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: input.name.trim().into(),
            description: input.description.clone().filter(|d| !d.trim().is_empty()),
            command: input.command.clone(),
            category: input.category.clone().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
            server_id: input.server_id.clone().filter(|s| !s.is_empty()),
            shortcut: input.shortcut.clone().filter(|s| !s.is_empty()),
            created_at: prev.as_ref().map(|p| p.created_at).unwrap_or(ts),
            updated_at: ts,
        };
        self.doc_put("snippets", &s.id, &s)?;
        Ok(s)
    }

    pub fn delete_snippet(&self, id: &str) -> Result<()> {
        self.doc_delete("snippets", id)?;
        Ok(())
    }

    // ───────── tunnels ─────────

    pub fn list_tunnels(&self) -> Result<Vec<TunnelConfig>> {
        let mut v: Vec<TunnelConfig> = self.doc_list("tunnels")?;
        v.sort_by_key(|a| a.name.to_lowercase());
        Ok(v)
    }

    pub fn get_tunnel(&self, id: &str) -> Result<TunnelConfig> {
        self.doc_get("tunnels", id)?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Tunnel not found", "This tunnel no longer exists."))
    }

    pub fn save_tunnel(&self, id: Option<&str>, input: &TunnelInput) -> Result<TunnelConfig> {
        if input.name.trim().is_empty() {
            return Err(AppError::invalid("Give the tunnel a name."));
        }
        if input.bind_port == 0 && input.kind != TunnelKind::Remote {
            return Err(AppError::invalid("Choose a local port between 1 and 65535."));
        }
        if input.kind != TunnelKind::Dynamic && (input.target_host.trim().is_empty() || input.target_port == 0) {
            return Err(AppError::invalid("Enter the destination host and port."));
        }
        self.get_server(&input.server_id)?;
        let t = TunnelConfig {
            id: id.map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            server_id: input.server_id.clone(),
            name: input.name.trim().into(),
            kind: input.kind,
            bind_host: if input.bind_host.trim().is_empty() { "127.0.0.1".into() } else { input.bind_host.trim().into() },
            bind_port: input.bind_port,
            target_host: input.target_host.trim().into(),
            target_port: input.target_port,
            auto_start: input.auto_start,
        };
        self.doc_put("tunnels", &t.id, &t)?;
        Ok(t)
    }

    pub fn delete_tunnel(&self, id: &str) -> Result<()> {
        self.doc_delete("tunnels", id)?;
        Ok(())
    }

    // ───────── workspaces ─────────

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let mut v: Vec<Workspace> = self.doc_list("workspaces")?;
        v.sort_by_key(|a| a.created_at);
        Ok(v)
    }

    pub fn get_workspace(&self, id: &str) -> Result<Workspace> {
        self.doc_get("workspaces", id)?
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Workspace not found", "This workspace no longer exists."))
    }

    pub fn create_workspace(&self, name: &str, server_ids: Vec<String>) -> Result<Workspace> {
        if name.trim().is_empty() {
            return Err(AppError::invalid("Give the workspace a name."));
        }
        let ts = now();
        let w = Workspace {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.trim().into(),
            icon: None,
            server_ids,
            layout: serde_json::json!({}),
            created_at: ts,
            updated_at: ts,
        };
        self.doc_put("workspaces", &w.id, &w)?;
        Ok(w)
    }

    pub fn save_workspace(&self, w: &Workspace) -> Result<Workspace> {
        let mut w = w.clone();
        w.updated_at = now();
        self.doc_put("workspaces", &w.id, &w)?;
        Ok(w)
    }

    pub fn delete_workspace(&self, id: &str) -> Result<()> {
        self.doc_delete("workspaces", id)?;
        Ok(())
    }

    // ───────── settings & kv ─────────

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.lock().query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO kv(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn settings(&self) -> Result<Settings> {
        let mut s: Settings = match self.kv_get("settings")? {
            Some(v) => serde_json::from_str(&v).unwrap_or_default(),
            None => Settings::default(),
        };
        s.ai.has_api_key = self.get_secret_raw(AI_KEY_ID)?.is_some();
        Ok(s)
    }

    pub fn save_settings(&self, s: &Settings) -> Result<Settings> {
        let mut s = s.clone();
        s.monitor_interval_ms = s.monitor_interval_ms.clamp(500, 60_000);
        s.background_monitor_interval_ms = s.background_monitor_interval_ms.clamp(2_000, 300_000);
        s.transfer_concurrency = s.transfer_concurrency.clamp(1, 8);
        s.terminal_scrollback = s.terminal_scrollback.clamp(500, 200_000);
        s.terminal_font_size = s.terminal_font_size.clamp(8, 36);
        self.kv_set("settings", &serde_json::to_string(&s)?)?;
        self.settings()
    }

    pub fn set_ai_key(&self, key: Option<&str>) -> Result<()> {
        match key {
            Some(k) if !k.trim().is_empty() => self.put_secret_raw(AI_KEY_ID, &SecretString::new(k.trim().to_string())),
            _ => self.delete_secret_raw(AI_KEY_ID),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn store() -> Storage {
        Storage::in_memory(Arc::new(Vault::with_key([3u8; 32]))).unwrap()
    }

    pub fn input(name: &str) -> ServerInput {
        ServerInput {
            name: name.into(),
            host: "10.0.0.1".into(),
            port: 22,
            username: "root".into(),
            auth_method: AuthMethod::Password,
            key_path: None,
            password: SecretUpdate::Set("pw-123".into()),
            passphrase: SecretUpdate::Keep,
            key_data: SecretUpdate::Keep,
            group: Some(" Production ".into()),
            tags: vec!["web".into(), "web".into(), " ".into()],
            favorite: false,
            color: None,
            notes: None,
            proxy: None,
            proxy_password: SecretUpdate::Keep,
            jump_host_id: None,
            keepalive_secs: 30,
            connect_timeout_secs: 10,
            auto_reconnect: true,
            use_tmux: false,
            startup_dir: None,
            startup_command: None,
        }
    }

    #[test]
    fn server_crud_and_secrets() {
        let s = store();
        let p = s.create_server(&input("web-1")).unwrap();
        assert!(p.has_password);
        assert_eq!(p.group.as_deref(), Some("Production"));
        assert_eq!(p.tags, vec!["web".to_string()]);
        assert_eq!(s.get_secret(&p.id, SecretKind::Password).unwrap().unwrap().expose(), "pw-123");

        // Secrets are never stored in plaintext.
        let raw: String = s.conn.lock().query_row("SELECT blob FROM secrets", [], |r| r.get(0)).unwrap();
        assert!(!raw.contains("pw-123"));
        let doc: String = s.conn.lock().query_row("SELECT data FROM servers", [], |r| r.get(0)).unwrap();
        assert!(!doc.contains("pw-123"));

        // Keep leaves the secret alone; Clear removes it.
        let mut i2 = input("web-1b");
        i2.password = SecretUpdate::Keep;
        let p2 = s.update_server(&p.id, &i2).unwrap();
        assert!(p2.has_password);
        assert_eq!(p2.name, "web-1b");
        i2.password = SecretUpdate::Clear;
        let p3 = s.update_server(&p.id, &i2).unwrap();
        assert!(!p3.has_password);
        assert!(s.get_secret(&p.id, SecretKind::Password).unwrap().is_none());

        let d = s.duplicate_server(&p.id).unwrap();
        assert_ne!(d.id, p.id);
        assert!(d.name.ends_with("(copy)"));

        s.delete_server(&p.id).unwrap();
        assert!(s.get_server(&p.id).is_err());
        assert_eq!(s.list_servers().unwrap().len(), 1);
    }

    #[test]
    fn duplicate_copies_secrets() {
        let s = store();
        let p = s.create_server(&input("a")).unwrap();
        let d = s.duplicate_server(&p.id).unwrap();
        assert_eq!(s.get_secret(&d.id, SecretKind::Password).unwrap().unwrap().expose(), "pw-123");
    }

    #[test]
    fn validation() {
        let s = store();
        let mut i = input("x");
        i.host = "bad host".into();
        assert_eq!(s.create_server(&i).unwrap_err().code, ErrorCode::InvalidInput);
        i.host = "".into();
        assert!(s.create_server(&i).is_err());
    }

    #[test]
    fn invalid_key_rejected() {
        let s = store();
        let mut i = input("k");
        i.auth_method = AuthMethod::Key;
        i.key_data = SecretUpdate::Set("not a key".into());
        assert_eq!(s.create_server(&i).unwrap_err().code, ErrorCode::KeyLoadFailed);
    }

    #[test]
    fn known_hosts_replace() {
        let s = store();
        s.trust_host_key("h", 22, "ssh-ed25519", "SHA256:aaa").unwrap();
        s.trust_host_key("h", 22, "ssh-ed25519", "SHA256:bbb").unwrap();
        let k = s.known_host_keys("h", 22).unwrap();
        assert_eq!(k.len(), 1);
        assert_eq!(k[0].fingerprint, "SHA256:bbb");
        s.forget_host("h", 22).unwrap();
        assert!(s.known_host_keys("h", 22).unwrap().is_empty());
    }

    #[test]
    fn deleting_server_removes_its_tunnels_and_snippets() {
        let s = store();
        let p = s.create_server(&input("a")).unwrap();
        s.save_tunnel(None, &TunnelInput {
            server_id: p.id.clone(),
            name: "db".into(),
            kind: TunnelKind::Local,
            bind_host: "".into(),
            bind_port: 5433,
            target_host: "127.0.0.1".into(),
            target_port: 5432,
            auto_start: false,
        })
        .unwrap();
        s.save_snippet(None, &SnippetInput {
            name: "x".into(),
            description: None,
            command: "ls".into(),
            category: None,
            server_id: Some(p.id.clone()),
            shortcut: None,
        })
        .unwrap();
        s.save_snippet(None, &SnippetInput { name: "g".into(), description: None, command: "ls".into(), category: None, server_id: None, shortcut: None }).unwrap();
        s.delete_server(&p.id).unwrap();
        assert!(s.list_tunnels().unwrap().is_empty());
        assert_eq!(s.list_snippets().unwrap().len(), 1);
    }

    #[test]
    fn settings_roundtrip_and_clamp() {
        let s = store();
        let mut st = s.settings().unwrap();
        st.monitor_interval_ms = 1;
        st.accent = "#ff0000".into();
        let saved = s.save_settings(&st).unwrap();
        assert_eq!(saved.monitor_interval_ms, 500);
        assert_eq!(s.settings().unwrap().accent, "#ff0000");
        s.set_ai_key(Some("sk-test")).unwrap();
        assert!(s.settings().unwrap().ai.has_api_key);
    }

    #[test]
    fn workspaces() {
        let s = store();
        let w = s.create_workspace("Shopify Infrastructure", vec!["a".into()]).unwrap();
        let mut w2 = w.clone();
        w2.layout = serde_json::json!({"tabs": [1, 2]});
        s.save_workspace(&w2).unwrap();
        assert_eq!(s.get_workspace(&w.id).unwrap().layout["tabs"][1], 2);
        s.delete_workspace(&w.id).unwrap();
        assert!(s.list_workspaces().unwrap().is_empty());
    }
}
