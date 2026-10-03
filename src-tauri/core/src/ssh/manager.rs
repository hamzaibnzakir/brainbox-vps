//! Owns every [`ServerConnection`], establishes them (direct, proxy or jump
//! host), authenticates, and supervises them for automatic reconnection.

use super::auth::{authenticate, Credentials};
use super::connection::{Live, ServerConnection};
use super::handler::ClientHandler;
use super::hostkey::{HostKeyGate, HostKeyOutcome};
use super::transport::{proxy_connect, tcp_connect, BoxIo};
use crate::error::{humanize_russh, AppError, ErrorCode, NetCtx, Result};
use crate::events::{names, EventSinkExt, SharedSink};
use crate::model::{AppNotification, ConnectionState, ConnectionStatus};
use crate::storage::{now, SecretKind, Storage};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const MAX_JUMP_DEPTH: u8 = 4;

#[derive(Debug, Clone)]
pub enum ConnEvent {
    Connected { server_id: String, generation: u64, reconnect: bool },
    Lost { server_id: String },
    Disconnected { server_id: String },
}

type Listener = Arc<dyn Fn(&ConnEvent) + Send + Sync>;

pub struct ConnectionManager {
    storage: Arc<Storage>,
    gate: Arc<HostKeyGate>,
    sink: SharedSink,
    conns: Mutex<HashMap<String, Arc<ServerConnection>>>,
    listeners: Mutex<Vec<Listener>>,
    /// Reconnect back-off cap (tests shorten this).
    pub max_backoff: Mutex<Duration>,
}

impl ConnectionManager {
    pub fn new(storage: Arc<Storage>, gate: Arc<HostKeyGate>, sink: SharedSink) -> Arc<Self> {
        Arc::new(Self {
            storage,
            gate,
            sink,
            conns: Mutex::new(HashMap::new()),
            listeners: Mutex::new(Vec::new()),
            max_backoff: Mutex::new(Duration::from_secs(30)),
        })
    }

    pub fn storage(&self) -> &Arc<Storage> {
        &self.storage
    }

    pub fn sink(&self) -> &SharedSink {
        &self.sink
    }

    pub fn gate(&self) -> &Arc<HostKeyGate> {
        &self.gate
    }

    pub fn on_event(&self, f: impl Fn(&ConnEvent) + Send + Sync + 'static) {
        self.listeners.lock().push(Arc::new(f));
    }

    fn fire(&self, ev: ConnEvent) {
        let ls: Vec<Listener> = self.listeners.lock().clone();
        for l in ls {
            l(&ev);
        }
    }

    fn publish(&self, st: &ConnectionStatus) {
        self.sink.emit(names::CONNECTION_STATUS, st);
    }

    fn notify(&self, kind: &str, title: String, body: String, server_id: &str) {
        self.sink.emit(names::NOTIFY, &AppNotification { kind: kind.into(), title, body, server_id: Some(server_id.into()) });
    }

    pub fn get(&self, server_id: &str) -> Option<Arc<ServerConnection>> {
        self.conns.lock().get(server_id).cloned()
    }

    /// A connected server or a clear "not connected" error.
    pub fn require(&self, server_id: &str) -> Result<Arc<ServerConnection>> {
        match self.get(server_id) {
            Some(c) if c.is_connected() => Ok(c),
            _ => Err(AppError::not_connected()),
        }
    }

    pub fn statuses(&self) -> Vec<ConnectionStatus> {
        self.conns.lock().values().map(|c| c.status()).collect()
    }

    pub fn connected_ids(&self) -> Vec<String> {
        self.conns.lock().values().filter(|c| c.is_connected()).map(|c| c.server_id.clone()).collect()
    }

    fn entry(&self, server_id: &str) -> Result<Arc<ServerConnection>> {
        let profile = self.storage.get_server(server_id)?;
        let mut map = self.conns.lock();
        let c = map.entry(server_id.to_string()).or_insert_with(|| Arc::new(ServerConnection::new(profile.clone())));
        *c.profile.lock() = profile;
        Ok(c.clone())
    }

    fn resolve_credentials(&self, conn: &ServerConnection) -> Result<Credentials> {
        let id = &conn.server_id;
        let mut c = Credentials {
            password: self.storage.get_secret(id, SecretKind::Password)?,
            passphrase: self.storage.get_secret(id, SecretKind::Passphrase)?,
            key_data: self.storage.get_secret(id, SecretKind::KeyData)?,
            proxy_password: self.storage.get_secret(id, SecretKind::ProxyPassword)?,
        };
        if let Some(o) = conn.creds_override.lock().clone() {
            if o.password.is_some() {
                c.password = o.password;
            }
            if o.passphrase.is_some() {
                c.passphrase = o.passphrase;
            }
            if o.key_data.is_some() {
                c.key_data = o.key_data;
            }
            if o.proxy_password.is_some() {
                c.proxy_password = o.proxy_password;
            }
        }
        Ok(c)
    }

    /// Connect (or return the existing live connection).
    pub async fn connect(self: &Arc<Self>, server_id: &str, creds: Option<Credentials>) -> Result<ConnectionStatus> {
        let c = self.connect_boxed(server_id.to_string(), creds, 0).await?;
        Ok(c.status())
    }

    fn connect_boxed(self: &Arc<Self>, server_id: String, creds: Option<Credentials>, depth: u8) -> BoxFuture<'static, Result<Arc<ServerConnection>>> {
        let me = self.clone();
        Box::pin(async move { me.connect_inner(&server_id, creds, depth).await })
    }

    async fn connect_inner(self: &Arc<Self>, server_id: &str, creds: Option<Credentials>, depth: u8) -> Result<Arc<ServerConnection>> {
        let conn = self.entry(server_id)?;
        let _guard = conn.connect_lock.lock().await;
        if conn.is_connected() {
            return Ok(conn.clone());
        }
        if let Some(c) = creds {
            *conn.creds_override.lock() = Some(c);
        }
        // Stop any supervisor still retrying from a previous session.
        conn.cancel.lock().cancel();
        *conn.cancel.lock() = CancellationToken::new();

        let st = conn.set_state(ConnectionState::Connecting);
        self.publish(&st);
        match self.establish(&conn, depth).await {
            Ok((live, info)) => {
                self.install(&conn, live, info, false);
                let _ = self.storage.patch_server(server_id, |p| p.last_connected_at = Some(now()));
                self.spawn_supervisor(conn.clone());
                Ok(conn.clone())
            }
            Err(e) => {
                let st = conn.set_state(ConnectionState::Failed { error: e.clone() });
                self.publish(&st);
                Err(e)
            }
        }
    }

    fn install(&self, conn: &Arc<ServerConnection>, live: Live, info: (Option<String>, Option<String>), reconnect: bool) {
        let gen = live.generation;
        *conn.live.write() = Some(live);
        conn.gen_tx.send_replace(gen);
        let st = conn.update_status(|s| {
            s.state = ConnectionState::Connected { since: now() };
            s.fingerprint = info.0;
            s.server_banner = info.1;
        });
        self.publish(&st);
        self.fire(ConnEvent::Connected { server_id: conn.server_id.clone(), generation: gen, reconnect });
    }

    pub async fn disconnect(&self, server_id: &str) {
        let Some(conn) = self.get(server_id) else { return };
        conn.cancel.lock().cancel();
        if let Some(live) = conn.take_live() {
            let _ = live.handle.disconnect(russh::Disconnect::ByApplication, "Brainbox VPS disconnect", "en").await;
        }
        conn.invalidate_sftp().await;
        *conn.creds_override.lock() = None;
        let st = conn.set_state(ConnectionState::Disconnected);
        self.publish(&st);
        self.fire(ConnEvent::Disconnected { server_id: server_id.to_string() });
    }

    pub async fn disconnect_all(&self) {
        let ids: Vec<String> = self.conns.lock().keys().cloned().collect();
        for id in ids {
            self.disconnect(&id).await;
        }
    }

    /// Forget a deleted server entirely.
    pub async fn remove(&self, server_id: &str) {
        self.disconnect(server_id).await;
        self.conns.lock().remove(server_id);
    }

    async fn establish(self: &Arc<Self>, conn: &Arc<ServerConnection>, depth: u8) -> Result<(Live, (Option<String>, Option<String>))> {
        let profile = self.storage.get_server(&conn.server_id)?;
        *conn.profile.lock() = profile.clone();
        let creds = self.resolve_credentials(conn)?;
        let timeout = Duration::from_secs(profile.connect_timeout_secs.max(3) as u64);
        let ctx = NetCtx::ssh(&profile.host, profile.port);

        // 1. Transport
        let (stream, jump): (BoxIo, Option<Arc<ServerConnection>>) = if let Some(jid) = profile.jump_host_id.clone() {
            if depth >= MAX_JUMP_DEPTH {
                return Err(AppError::new(ErrorCode::JumpHostFailed, "Jump host chain too long", "The jump host configuration forms a loop or is too deep."));
            }
            let jump = self.connect_boxed(jid.clone(), None, depth + 1).await.map_err(|e| {
                let jname = self.storage.get_server(&jid).map(|s| s.name).unwrap_or_else(|_| "the jump host".into());
                AppError::new(ErrorCode::JumpHostFailed, "Jump host failed", format!("Could not connect through {jname}: {}", e.message))
                    .causes(e.causes.clone())
                    .details(e.details.clone().unwrap_or_default())
            })?;
            let jh = jump.handle()?;
            let ch = tokio::time::timeout(timeout, jh.channel_open_direct_tcpip(profile.host.clone(), profile.port as u32, "127.0.0.1", 0))
                .await
                .map_err(|_| AppError::new(ErrorCode::ConnectionTimeout, "Connection timed out", format!("The jump host could not reach {}:{} in time.", profile.host, profile.port)))?
                .map_err(|e| {
                    AppError::new(ErrorCode::JumpHostFailed, "Jump host could not reach the server", format!("The jump host could not open a connection to {}:{}.", profile.host, profile.port))
                        .causes(["The server may be offline or unreachable from the jump host", "TCP forwarding may be disabled on the jump host (AllowTcpForwarding)"])
                        .details(e.to_string())
                })?;
            (Box::new(ch.into_stream()), Some(jump))
        } else if let Some(proxy) = &profile.proxy {
            let s = proxy_connect(proxy, creds.proxy_password.as_ref(), &profile.host, profile.port, timeout).await?;
            (Box::new(s), None)
        } else {
            (Box::new(tcp_connect(&profile.host, profile.port, timeout, &ctx).await?), None)
        };

        // 2. SSH handshake (host key verification happens inside).
        let hostkey = Arc::new(Mutex::new(None::<HostKeyOutcome>));
        let banner = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            server_id: profile.id.clone(),
            host: profile.host.clone(),
            port: profile.port,
            gate: self.gate.clone(),
            hostkey: hostkey.clone(),
            banner: banner.clone(),
            router: conn.router.clone(),
        };
        let keepalive = if profile.keepalive_secs > 0 { Some(Duration::from_secs(profile.keepalive_secs as u64)) } else { None };
        let config = Arc::new(russh::client::Config {
            keepalive_interval: keepalive,
            keepalive_max: 3,
            nodelay: true,
            window_size: 4 * 1024 * 1024,
            ..Default::default()
        });

        let fut = russh::client::connect_stream(config, stream, handler);
        tokio::pin!(fut);
        // The handshake may pause on a host-key prompt; don't count that time.
        let mut active = Duration::ZERO;
        let mut last = Instant::now();
        let handshake = loop {
            tokio::select! {
                r = &mut fut => break r,
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    let n = Instant::now();
                    let waiting_for_user = hostkey.lock().is_none() && !self.gate.prompts().pending().is_empty();
                    if !waiting_for_user {
                        active += n - last;
                    }
                    last = n;
                    if active > timeout {
                        return Err(AppError::new(ErrorCode::ConnectionTimeout, "Connection timed out", format!("{} accepted the connection but the SSH handshake did not complete.", profile.host))
                            .causes(["The port may not be an SSH server", "The server may be overloaded"]));
                    }
                }
            }
        };
        let mut handle = match handshake {
            Ok(h) => h,
            Err(e) => {
                let hk = hostkey.lock().clone();
                if let Some(hk) = hk {
                    if !hk.accepted {
                        if let Some(prev) = hk.mismatch_previous {
                            return Err(AppError::new(
                                ErrorCode::HostKeyMismatch,
                                "Server identity changed!",
                                format!("The host key for {} is different from the one you trusted before. The connection was blocked.", profile.host),
                            )
                            .causes([
                                "The server was reinstalled or its SSH keys were regenerated",
                                "Someone may be intercepting the connection (man-in-the-middle attack)",
                            ])
                            .details(format!("Trusted: {prev}\nPresented: {} ({})", hk.fingerprint, hk.algorithm)));
                        }
                        return Err(AppError::new(ErrorCode::HostKeyRejected, "Connection cancelled", "The server's host key was not trusted.")
                            .details(format!("{} {}", hk.algorithm, hk.fingerprint)));
                    }
                }
                return Err(humanize_russh(&e, &ctx));
            }
        };

        // 3. Authentication.
        match tokio::time::timeout(timeout * 2, authenticate(&mut handle, &profile, &creds)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(AppError::new(ErrorCode::ConnectionTimeout, "Login timed out", "The server did not finish authentication in time.")),
        }

        let fp = hostkey.lock().as_ref().map(|h| format!("{} {}", h.algorithm, h.fingerprint));
        let generation = conn.generation() + 1;
        let b = banner.lock().clone();
        Ok((Live { handle: Arc::new(handle), generation, _jump: jump }, (fp, b)))
    }

    fn spawn_supervisor(self: &Arc<Self>, conn: Arc<ServerConnection>) {
        let me = Arc::downgrade(self);
        let cancel = conn.cancel_token();
        crate::rt::spawn(async move {
            let mut lat = tokio::time::interval(Duration::from_secs(15));
            lat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                // Watch the live connection.
                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        _ = tokio::time::sleep(Duration::from_millis(750)) => {
                            if conn.handle_closed() { break; }
                        }
                        _ = lat.tick() => {
                            if let Ok(h) = conn.handle() {
                                let t0 = Instant::now();
                                let ok = tokio::time::timeout(Duration::from_secs(10), h.channel_open_session()).await;
                                if let Ok(Ok(ch)) = ok {
                                    let ms = t0.elapsed().as_millis() as u32;
                                    let _ = ch.close().await;
                                    if let Some(m) = me.upgrade() {
                                        let st = conn.update_status(|s| s.latency_ms = Some(ms));
                                        m.publish(&st);
                                    }
                                }
                            }
                        }
                    }
                }
                let Some(mgr) = me.upgrade() else { return };
                let _ = conn.take_live();
                conn.invalidate_sftp().await;
                let profile = conn.profile();
                mgr.fire(ConnEvent::Lost { server_id: conn.server_id.clone() });
                mgr.notify("ssh_disconnected", format!("{} disconnected", profile.name), "The SSH connection was lost.".into(), &conn.server_id);

                if !profile.auto_reconnect {
                    let st = conn.set_state(ConnectionState::Failed {
                        error: AppError::new(ErrorCode::Disconnected, "Disconnected", format!("The connection to {} was lost.", profile.host)),
                    });
                    mgr.publish(&st);
                    return;
                }

                let mut attempt: u32 = 0;
                loop {
                    attempt += 1;
                    let cap = *mgr.max_backoff.lock();
                    let delay = Duration::from_millis((500u64 << (attempt - 1).min(8)).min(cap.as_millis() as u64));
                    let st = conn.set_state(ConnectionState::Reconnecting { attempt, next_retry_ms: delay.as_millis() as u64 });
                    mgr.publish(&st);
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        _ = tokio::time::sleep(delay) => {}
                    }
                    let guard = conn.connect_lock.lock().await;
                    if cancel.is_cancelled() {
                        return;
                    }
                    match mgr.establish(&conn, 0).await {
                        Ok((live, info)) => {
                            mgr.install(&conn, live, info, true);
                            drop(guard);
                            mgr.notify("ssh_reconnected", format!("{} reconnected", profile.name), format!("Back online after {attempt} attempt(s)."), &conn.server_id);
                            break;
                        }
                        Err(e) => {
                            drop(guard);
                            let fatal = matches!(
                                e.code,
                                ErrorCode::AuthFailed | ErrorCode::NeedPassword | ErrorCode::NeedPassphrase | ErrorCode::BadPassphrase
                                    | ErrorCode::HostKeyMismatch | ErrorCode::HostKeyRejected | ErrorCode::KeyLoadFailed | ErrorCode::NotFound
                            );
                            if attempt == 3 {
                                mgr.notify("server_unreachable", format!("{} is unreachable", profile.name), e.message.clone(), &conn.server_id);
                            }
                            if fatal {
                                let st = conn.set_state(ConnectionState::Failed { error: e });
                                mgr.publish(&st);
                                return;
                            }
                            log::info!("reconnect attempt {attempt} for {} failed: {}", profile.name, e.message);
                        }
                    }
                }
            }
        });
    }
}
