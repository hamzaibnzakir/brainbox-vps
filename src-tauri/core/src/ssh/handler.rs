//! russh client handler: host-key verification, auth banner capture and
//! routing of server-initiated `forwarded-tcpip` channels (remote tunnels).

use super::hostkey::{HostKeyGate, HostKeyOutcome};
use parking_lot::Mutex;
use russh::client::{Msg, Session};
use russh::keys::PublicKeyOrCertificate;
use russh::Channel;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

/// Live counters for one tunnel.
#[derive(Default, Debug)]
pub struct TunnelStats {
    pub active: AtomicU32,
    pub bytes_in: AtomicU64,
    pub bytes_out: AtomicU64,
}

#[derive(Clone)]
pub struct RemoteTarget {
    pub host: String,
    pub port: u16,
    pub stats: Arc<TunnelStats>,
}

/// Maps remote-forward listen ports (on the server) to local targets.
#[derive(Default)]
pub struct ForwardRouter {
    routes: Mutex<HashMap<u32, RemoteTarget>>,
}

impl ForwardRouter {
    pub fn add(&self, remote_port: u32, target: RemoteTarget) {
        self.routes.lock().insert(remote_port, target);
    }
    pub fn remove(&self, remote_port: u32) {
        self.routes.lock().remove(&remote_port);
    }
    pub fn get(&self, remote_port: u32) -> Option<RemoteTarget> {
        self.routes.lock().get(&remote_port).cloned()
    }
}

pub struct ClientHandler {
    pub server_id: String,
    pub host: String,
    pub port: u16,
    pub gate: Arc<HostKeyGate>,
    pub hostkey: Arc<Mutex<Option<HostKeyOutcome>>>,
    pub banner: Arc<Mutex<Option<String>>>,
    pub router: Arc<ForwardRouter>,
}

impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        let outcome = self.gate.check(&self.server_id, &self.host, self.port, &key).await;
        let ok = outcome.accepted;
        *self.hostkey.lock() = Some(outcome);
        Ok(ok)
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut Session) -> Result<(), Self::Error> {
        let b = banner.trim();
        if !b.is_empty() {
            *self.banner.lock() = Some(b.chars().take(4000).collect());
        }
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(target) = self.router.get(connected_port) else {
            log::warn!("forwarded connection for unknown remote port {connected_port}; rejecting");
            drop(reply); // dropping rejects the channel
            return Ok(());
        };
        reply.accept().await;
        crate::rt::spawn(async move {
            match tokio::net::TcpStream::connect((target.host.as_str(), target.port)).await {
                Ok(tcp) => {
                    let _ = tcp.set_nodelay(true);
                    crate::tunnels::bridge(channel.into_stream(), tcp, target.stats).await;
                }
                Err(e) => {
                    log::warn!("remote forward: cannot reach local target {}:{}: {e}", target.host, target.port);
                    let _ = channel.close().await;
                }
            }
        });
        Ok(())
    }
}

/// Track active connections on a tunnel for the duration of a guard.
pub struct ActiveGuard(pub Arc<TunnelStats>);
impl ActiveGuard {
    pub fn new(stats: Arc<TunnelStats>) -> Self {
        stats.active.fetch_add(1, Ordering::Relaxed);
        Self(stats)
    }
}
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}
