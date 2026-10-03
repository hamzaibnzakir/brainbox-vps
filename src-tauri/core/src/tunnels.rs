//! SSH tunnels: local (-L), remote (-R) and dynamic SOCKS5 (-D) forwarding.

use crate::error::{AppError, ErrorCode, Result};
use crate::events::{names, EventSinkExt, SharedSink};
use crate::model::{TunnelConfig, TunnelKind, TunnelState, TunnelStatus};
use crate::ssh::handler::{ActiveGuard, RemoteTarget, TunnelStats};
use crate::ssh::manager::ConnEvent;
use crate::ssh::{ConnectionManager, ServerConnection};
use crate::storage::Storage;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

/// Pump bytes both ways between an SSH channel stream and a TCP socket,
/// updating live counters.
pub async fn bridge<A, B>(chan: A, tcp: B, stats: Arc<TunnelStats>)
where
    A: AsyncRead + AsyncWrite + Unpin + Send,
    B: AsyncRead + AsyncWrite + Unpin + Send,
{
    let _g = ActiveGuard::new(stats.clone());
    let (mut cr, mut cw) = tokio::io::split(chan);
    let (mut tr, mut tw) = tokio::io::split(tcp);
    let s1 = stats.clone();
    let up = async move {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match tr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if cw.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                    s1.bytes_out.fetch_add(n as u64, Ordering::Relaxed);
                }
            }
        }
        let _ = cw.shutdown().await;
    };
    let s2 = stats.clone();
    let down = async move {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match cr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tw.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                    s2.bytes_in.fetch_add(n as u64, Ordering::Relaxed);
                }
            }
        }
        let _ = tw.shutdown().await;
    };
    tokio::join!(up, down);
}

/// Server side of a SOCKS5 CONNECT handshake. Returns the requested target.
pub async fn socks5_accept<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> std::io::Result<(String, u16)> {
    let mut head = [0u8; 2];
    s.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Err(std::io::Error::other("not a SOCKS5 client"));
    }
    let mut methods = vec![0u8; head[1] as usize];
    s.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        s.write_all(&[5, 0xff]).await?;
        return Err(std::io::Error::other("client requires authentication"));
    }
    s.write_all(&[5, 0]).await?;
    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    if req[1] != 1 {
        s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Err(std::io::Error::other("only CONNECT is supported"));
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).await?;
            let mut name = vec![0u8; l[0] as usize];
            s.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        _ => {
            s.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Err(std::io::Error::other("bad address type"));
        }
    };
    let mut p = [0u8; 2];
    s.read_exact(&mut p).await?;
    Ok((host, u16::from_be_bytes(p)))
}

struct Running {
    config: TunnelConfig,
    cancel: CancellationToken,
    stats: Arc<TunnelStats>,
    state: Arc<Mutex<(TunnelState, Option<AppError>)>>,
    remote_port: Arc<Mutex<Option<u32>>>,
}

pub struct TunnelManager {
    conns: Arc<ConnectionManager>,
    storage: Arc<Storage>,
    sink: SharedSink,
    running: Mutex<HashMap<String, Running>>,
}

fn bind_error(cfg: &TunnelConfig, e: &std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::AddrInUse {
        AppError::new(ErrorCode::AlreadyExists, "Port in use", format!("Port {} is already in use on this computer.", cfg.bind_port))
            .causes(["Another program (or another tunnel) is listening on this port", "Choose a different local port"])
            .details(e.to_string())
    } else if e.kind() == std::io::ErrorKind::PermissionDenied {
        AppError::new(ErrorCode::PermissionDenied, "Port not allowed", format!("Brainbox VPS is not allowed to listen on port {}.", cfg.bind_port))
            .causes(["Ports below 1024 may require administrator rights", "Windows may reserve this port (see `netsh int ipv4 show excludedportrange`)"])
            .details(e.to_string())
    } else {
        AppError::new(ErrorCode::Io, "Cannot open local port", format!("Could not listen on {}:{}.", cfg.bind_host, cfg.bind_port)).details(e.to_string())
    }
}

impl TunnelManager {
    pub fn new(conns: Arc<ConnectionManager>, storage: Arc<Storage>, sink: SharedSink) -> Arc<Self> {
        let me = Arc::new(Self { conns: conns.clone(), storage, sink, running: Mutex::new(HashMap::new()) });
        let weak: Weak<Self> = Arc::downgrade(&me);
        conns.on_event(move |ev| {
            if let Some(m) = weak.upgrade() {
                let ev = ev.clone();
                crate::rt::spawn(async move { m.on_conn_event(ev).await });
            }
        });
        // Periodic stats publisher.
        let weak2 = Arc::downgrade(&me);
        crate::rt::spawn(async move {
            let mut last: HashMap<String, (u32, u64, u64, TunnelState)> = HashMap::new();
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(m) = weak2.upgrade() else { return };
                for st in m.statuses() {
                    let key = (st.active_connections, st.bytes_in, st.bytes_out, st.state);
                    if last.get(&st.id) != Some(&key) {
                        last.insert(st.id.clone(), key);
                        m.sink.emit(names::TUNNEL, &st);
                    }
                }
            }
        });
        me
    }

    async fn on_conn_event(self: &Arc<Self>, ev: ConnEvent) {
        match ev {
            ConnEvent::Connected { server_id, reconnect, .. } => {
                if reconnect {
                    // Re-establish remote forwards; local listeners are still running.
                    let ids: Vec<String> = self.running.lock().values().filter(|r| r.config.server_id == server_id).map(|r| r.config.id.clone()).collect();
                    for id in ids {
                        let r = self.running.lock().get(&id).map(|r| (r.config.clone(), r.state.clone(), r.remote_port.clone(), r.stats.clone()));
                        if let Some((cfg, state, rp, stats)) = r {
                            if cfg.kind == TunnelKind::Remote {
                                match self.register_remote(&cfg, stats).await {
                                    Ok(p) => {
                                        *rp.lock() = Some(p);
                                        *state.lock() = (TunnelState::Running, None);
                                    }
                                    Err(e) => *state.lock() = (TunnelState::Error, Some(e)),
                                }
                            } else {
                                *state.lock() = (TunnelState::Running, None);
                            }
                            self.publish(&id);
                        }
                    }
                } else {
                    let auto: Vec<TunnelConfig> =
                        self.storage.list_tunnels().unwrap_or_default().into_iter().filter(|t| t.server_id == server_id && t.auto_start).collect();
                    for t in auto {
                        if !self.running.lock().contains_key(&t.id) {
                            if let Err(e) = self.start(&t.id).await {
                                log::warn!("auto-start tunnel {} failed: {}", t.name, e.message);
                            }
                        }
                    }
                }
            }
            ConnEvent::Lost { server_id } => {
                for r in self.running.lock().values().filter(|r| r.config.server_id == server_id) {
                    *r.state.lock() = (TunnelState::Waiting, None);
                }
            }
            ConnEvent::Disconnected { server_id } => {
                let ids: Vec<String> = self.running.lock().values().filter(|r| r.config.server_id == server_id).map(|r| r.config.id.clone()).collect();
                for id in ids {
                    self.stop(&id).await;
                }
            }
        }
    }

    fn publish(&self, id: &str) {
        if let Some(s) = self.status(id) {
            self.sink.emit(names::TUNNEL, &s);
        }
    }

    pub fn status(&self, id: &str) -> Option<TunnelStatus> {
        let r = self.running.lock();
        r.get(id).map(|r| {
            let (state, error) = r.state.lock().clone();
            TunnelStatus {
                id: id.to_string(),
                state,
                active_connections: r.stats.active.load(Ordering::Relaxed),
                bytes_in: r.stats.bytes_in.load(Ordering::Relaxed),
                bytes_out: r.stats.bytes_out.load(Ordering::Relaxed),
                error,
            }
        })
    }

    pub fn statuses(&self) -> Vec<TunnelStatus> {
        let ids: Vec<String> = self.running.lock().keys().cloned().collect();
        ids.iter().filter_map(|i| self.status(i)).collect()
    }

    async fn register_remote(&self, cfg: &TunnelConfig, stats: Arc<TunnelStats>) -> Result<u32> {
        let conn = self.conns.require(&cfg.server_id)?;
        let h = conn.handle()?;
        let port = h.tcpip_forward(cfg.bind_host.clone(), cfg.bind_port as u32).await.map_err(|e| {
            AppError::new(ErrorCode::PermissionDenied, "Server refused remote forwarding", format!("The server would not listen on {}:{}.", cfg.bind_host, cfg.bind_port))
                .causes(["AllowTcpForwarding or GatewayPorts may be disabled in sshd_config", "The remote port may already be in use", "Ports below 1024 need root on the server"])
                .details(e.to_string())
        })?;
        let actual = if port == 0 { cfg.bind_port as u32 } else { port };
        conn.router.add(actual, RemoteTarget { host: cfg.target_host.clone(), port: cfg.target_port, stats });
        Ok(actual)
    }

    pub async fn start(self: &Arc<Self>, id: &str) -> Result<TunnelStatus> {
        if let Some(s) = self.status(id) {
            if s.state != TunnelState::Error {
                return Ok(s);
            }
            self.stop(id).await;
        }
        let cfg = self.storage.get_tunnel(id)?;
        let conn = self.conns.require(&cfg.server_id)?;
        let cancel = CancellationToken::new();
        let stats = Arc::new(TunnelStats::default());
        let state = Arc::new(Mutex::new((TunnelState::Starting, None)));
        let remote_port = Arc::new(Mutex::new(None));

        match cfg.kind {
            TunnelKind::Local | TunnelKind::Dynamic => {
                let listener = TcpListener::bind((cfg.bind_host.as_str(), cfg.bind_port)).await.map_err(|e| bind_error(&cfg, &e))?;
                crate::rt::spawn(accept_loop(listener, conn.clone(), cfg.clone(), stats.clone(), state.clone(), cancel.clone()));
                *state.lock() = (TunnelState::Running, None);
            }
            TunnelKind::Remote => {
                let p = self.register_remote(&cfg, stats.clone()).await?;
                *remote_port.lock() = Some(p);
                *state.lock() = (TunnelState::Running, None);
            }
        }
        self.running.lock().insert(id.to_string(), Running { config: cfg, cancel, stats, state, remote_port });
        self.publish(id);
        Ok(self.status(id).expect("just inserted"))
    }

    pub async fn stop(&self, id: &str) {
        let r = self.running.lock().remove(id);
        if let Some(r) = r {
            r.cancel.cancel();
            if r.config.kind == TunnelKind::Remote {
                if let Some(conn) = self.conns.get(&r.config.server_id) {
                    let port = *r.remote_port.lock();
                    if let Some(p) = port {
                        conn.router.remove(p);
                        if let Ok(h) = conn.handle() {
                            let _ = h.cancel_tcpip_forward(r.config.bind_host.clone(), p).await;
                        }
                    }
                }
            }
            self.sink.emit(
                names::TUNNEL,
                &TunnelStatus { id: id.to_string(), state: TunnelState::Stopped, active_connections: 0, bytes_in: 0, bytes_out: 0, error: None },
            );
        }
    }

    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.running.lock().keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }
}

async fn accept_loop(
    listener: TcpListener,
    conn: Arc<ServerConnection>,
    cfg: TunnelConfig,
    stats: Arc<TunnelStats>,
    state: Arc<Mutex<(TunnelState, Option<AppError>)>>,
    cancel: CancellationToken,
) {
    loop {
        let (sock, peer) = tokio::select! {
            _ = cancel.cancelled() => return,
            r = listener.accept() => match r {
                Ok(x) => x,
                Err(e) => { log::warn!("tunnel accept failed: {e}"); tokio::time::sleep(Duration::from_millis(200)).await; continue; }
            }
        };
        let _ = sock.set_nodelay(true);
        let conn = conn.clone();
        let cfg = cfg.clone();
        let stats = stats.clone();
        let state = state.clone();
        let cancel = cancel.clone();
        crate::rt::spawn(async move {
            let res = handle_client(sock, peer, &conn, &cfg, stats, &cancel).await;
            if let Err(e) = res {
                log::debug!("tunnel {} client error: {}", cfg.name, e.message);
                if e.code == ErrorCode::NotConnected {
                    *state.lock() = (TunnelState::Waiting, None);
                }
            }
        });
    }
}

async fn handle_client(
    mut sock: TcpStream,
    peer: std::net::SocketAddr,
    conn: &ServerConnection,
    cfg: &TunnelConfig,
    stats: Arc<TunnelStats>,
    cancel: &CancellationToken,
) -> Result<()> {
    let (host, port) = if cfg.kind == TunnelKind::Dynamic {
        socks5_accept(&mut sock).await.map_err(|e| AppError::new(ErrorCode::ProxyFailed, "SOCKS error", e.to_string()))?
    } else {
        (cfg.target_host.clone(), cfg.target_port)
    };
    let h = match conn.handle() {
        Ok(h) => h,
        Err(e) => {
            if cfg.kind == TunnelKind::Dynamic {
                let _ = sock.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            return Err(e);
        }
    };
    let ch = h.channel_open_direct_tcpip(host.clone(), port as u32, peer.ip().to_string(), peer.port() as u32).await;
    let ch = match ch {
        Ok(c) => c,
        Err(e) => {
            if cfg.kind == TunnelKind::Dynamic {
                let _ = sock.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            return Err(AppError::new(ErrorCode::ConnectionRefused, "Tunnel target unreachable", format!("The server could not connect to {host}:{port}.")).details(e.to_string()));
        }
    };
    if cfg.kind == TunnelKind::Dynamic {
        sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.map_err(|e| AppError::new(ErrorCode::Io, "SOCKS error", e.to_string()))?;
    }
    tokio::select! {
        _ = bridge(ch.into_stream(), sock, stats) => {}
        _ = cancel.cancelled() => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn socks5_server_parses_domain_request() {
        let (mut client, mut server) = duplex(1024);
        let t = crate::rt::spawn(async move { socks5_accept(&mut server).await.unwrap() });
        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut r = [0u8; 2];
        client.read_exact(&mut r).await.unwrap();
        assert_eq!(r, [5, 0]);
        let mut req = vec![5, 1, 0, 3, 9];
        req.extend_from_slice(b"localhost");
        req.extend_from_slice(&8080u16.to_be_bytes());
        client.write_all(&req).await.unwrap();
        assert_eq!(t.await.unwrap(), ("localhost".to_string(), 8080));
    }

    #[tokio::test]
    async fn bridge_counts_bytes() {
        let (a1, mut a2) = duplex(1024);
        let (b1, mut b2) = duplex(1024);
        let stats = Arc::new(TunnelStats::default());
        let s = stats.clone();
        let h = crate::rt::spawn(async move { bridge(a1, b1, s).await });
        b2.write_all(b"hello").await.unwrap();
        let mut buf = [0u8; 5];
        a2.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");
        a2.write_all(b"world!").await.unwrap();
        let mut buf2 = [0u8; 6];
        b2.read_exact(&mut buf2).await.unwrap();
        drop(a2);
        drop(b2);
        h.await.unwrap();
        assert_eq!(stats.bytes_out.load(Ordering::Relaxed), 5);
        assert_eq!(stats.bytes_in.load(Ordering::Relaxed), 6);
        assert_eq!(stats.active.load(Ordering::Relaxed), 0);
    }
}
