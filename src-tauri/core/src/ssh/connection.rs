//! One multiplexed SSH connection per server.
//!
//! Every terminal, SFTP browser, transfer, monitor poll, log stream and tunnel
//! for a server opens its own *channel* on this single connection. A
//! supervisor task watches the connection, measures latency and transparently
//! reconnects with exponential back-off; consumers watch the `generation`
//! counter to re-attach after a reconnect.

use super::auth::Credentials;
use super::handler::{ClientHandler, ForwardRouter};
use crate::error::{AppError, ErrorCode, Result};
use crate::model::{ConnectionState, ConnectionStatus, ServerProfile};
use parking_lot::{Mutex, RwLock};
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

pub type SshHandle = Handle<ClientHandler>;

pub(crate) struct Live {
    pub handle: Arc<SshHandle>,
    pub generation: u64,
    /// Keeps the jump host connection referenced while this one is alive.
    pub _jump: Option<Arc<ServerConnection>>,
}

pub struct ServerConnection {
    pub server_id: String,
    pub(crate) profile: Mutex<ServerProfile>,
    /// One-time credentials supplied by the user (kept in memory, zeroized on
    /// drop) so automatic reconnects work without saving them.
    pub(crate) creds_override: Mutex<Option<Credentials>>,
    pub(crate) live: RwLock<Option<Live>>,
    pub(crate) status_tx: watch::Sender<ConnectionStatus>,
    pub(crate) gen_tx: watch::Sender<u64>,
    pub(crate) cancel: Mutex<CancellationToken>,
    pub(crate) connect_lock: tokio::sync::Mutex<()>,
    pub router: Arc<ForwardRouter>,
    sftp_cache: tokio::sync::Mutex<Option<(u64, Arc<SftpSession>)>>,
    probe_cache: Mutex<HashMap<String, (u64, String)>>,
}

impl ServerConnection {
    pub(crate) fn new(profile: ServerProfile) -> Self {
        let status = ConnectionStatus {
            server_id: profile.id.clone(),
            state: ConnectionState::Disconnected,
            latency_ms: None,
            fingerprint: None,
            server_banner: None,
        };
        Self {
            server_id: profile.id.clone(),
            profile: Mutex::new(profile),
            creds_override: Mutex::new(None),
            live: RwLock::new(None),
            status_tx: watch::channel(status).0,
            gen_tx: watch::channel(0).0,
            cancel: Mutex::new(CancellationToken::new()),
            connect_lock: tokio::sync::Mutex::new(()),
            router: Arc::new(ForwardRouter::default()),
            sftp_cache: tokio::sync::Mutex::new(None),
            probe_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn profile(&self) -> ServerProfile {
        self.profile.lock().clone()
    }

    pub fn status(&self) -> ConnectionStatus {
        self.status_tx.borrow().clone()
    }

    pub fn subscribe_status(&self) -> watch::Receiver<ConnectionStatus> {
        self.status_tx.subscribe()
    }

    /// Increments after every successful (re)connect.
    pub fn subscribe_generation(&self) -> watch::Receiver<u64> {
        self.gen_tx.subscribe()
    }

    pub fn generation(&self) -> u64 {
        *self.gen_tx.borrow()
    }

    pub fn is_connected(&self) -> bool {
        self.live.read().as_ref().is_some_and(|l| !l.handle.is_closed())
    }

    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel.lock().clone()
    }

    /// The live SSH handle, or a "not connected" error.
    pub fn handle(&self) -> Result<Arc<SshHandle>> {
        match self.live.read().as_ref() {
            Some(l) if !l.handle.is_closed() => Ok(l.handle.clone()),
            _ => Err(AppError::not_connected()),
        }
    }

    pub(crate) fn handle_closed(&self) -> bool {
        self.live.read().as_ref().is_none_or(|l| l.handle.is_closed())
    }

    pub(crate) fn take_live(&self) -> Option<Live> {
        self.live.write().take()
    }

    pub(crate) fn update_status<F: FnOnce(&mut ConnectionStatus)>(&self, f: F) -> ConnectionStatus {
        let mut s = self.status_tx.borrow().clone();
        f(&mut s);
        self.status_tx.send_replace(s.clone());
        s
    }

    pub fn set_state(&self, state: ConnectionState) -> ConnectionStatus {
        self.update_status(|s| {
            if !matches!(state, ConnectionState::Connected { .. }) {
                s.latency_ms = None;
            }
            s.state = state
        })
    }

    /// Wait until connected (returns the generation) or until `cancel` fires
    /// or the connection gives up (Failed/Disconnected).
    pub async fn wait_connected(&self, after_gen: u64, cancel: &CancellationToken) -> Option<u64> {
        let mut rx = self.subscribe_status();
        loop {
            {
                let st = rx.borrow_and_update().clone();
                match st.state {
                    ConnectionState::Connected { .. } if self.generation() > after_gen && self.is_connected() => {
                        return Some(self.generation())
                    }
                    ConnectionState::Failed { .. } | ConnectionState::Disconnected => return None,
                    _ => {}
                }
            }
            tokio::select! {
                _ = cancel.cancelled() => return None,
                r = rx.changed() => if r.is_err() { return None },
            }
        }
    }

    // ───────── SFTP ─────────

    async fn open_sftp(&self) -> Result<SftpSession> {
        let handle = self.handle()?;
        let ctx = {
            let p = self.profile.lock();
            crate::error::NetCtx::ssh(&p.host, p.port)
        };
        let ch = handle.channel_open_session().await.map_err(|e| crate::error::humanize_russh(&e, &ctx))?;
        ch.request_subsystem(true, "sftp").await.map_err(|e| crate::error::humanize_russh(&e, &ctx))?;
        let cfg = russh_sftp::client::Config { max_concurrent_writes: 48, max_concurrent_reads: 32, request_timeout_secs: 30, ..Default::default() };
        SftpSession::new_with_config(ch.into_stream(), cfg).await.map_err(|e| {
            AppError::new(ErrorCode::Unsupported, "SFTP unavailable", "The server did not start an SFTP session.")
                .causes(["The SFTP subsystem may be disabled in sshd_config", "The account's shell may print text on login, which breaks SFTP"])
                .details(e.to_string())
        })
    }

    /// Shared SFTP session for browsing (re-created after reconnects).
    pub async fn sftp(&self) -> Result<Arc<SftpSession>> {
        let gen = self.generation();
        let mut cache = self.sftp_cache.lock().await;
        if let Some((g, s)) = cache.as_ref() {
            if *g == gen && self.is_connected() {
                return Ok(s.clone());
            }
        }
        let s = Arc::new(self.open_sftp().await?);
        *cache = Some((gen, s.clone()));
        Ok(s)
    }

    pub async fn invalidate_sftp(&self) {
        *self.sftp_cache.lock().await = None;
    }

    /// Dedicated SFTP session (for transfers, so they don't block browsing).
    pub async fn new_sftp(&self) -> Result<SftpSession> {
        self.open_sftp().await
    }

    // ───────── capability probe cache ─────────

    pub fn probe_get(&self, key: &str) -> Option<String> {
        let gen = self.generation();
        self.probe_cache.lock().get(key).filter(|(g, _)| *g == gen).map(|(_, v)| v.clone())
    }

    pub fn probe_set(&self, key: &str, value: String) {
        let gen = self.generation();
        self.probe_cache.lock().insert(key.to_string(), (gen, value));
    }
}
