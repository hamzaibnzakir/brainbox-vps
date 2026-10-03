//! Application state shared by all commands.

use brainbox_core::ai::AiService;
use brainbox_core::events::SharedSink;
use brainbox_core::logs::LogStreams;
use brainbox_core::monitoring::Monitor;
use brainbox_core::privileged::SudoCache;
use brainbox_core::security::Vault;
use brainbox_core::sftp::transfer::TransferManager;
use brainbox_core::ssh::hostkey::{HostKeyGate, PromptHub};
use brainbox_core::ssh::ConnectionManager;
use brainbox_core::storage::Storage;
use brainbox_core::terminal::TerminalManager;
use brainbox_core::tunnels::TunnelManager;
use brainbox_core::Result;
use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    pub data_dir: PathBuf,
    pub vault_backend: &'static str,
    pub storage: Arc<Storage>,
    pub conns: Arc<ConnectionManager>,
    pub prompts: Arc<PromptHub>,
    pub terminals: TerminalManager,
    pub transfers: Arc<TransferManager>,
    pub tunnels: Arc<TunnelManager>,
    pub monitor: Arc<Monitor>,
    pub logs: LogStreams,
    pub sudo: Arc<SudoCache>,
    pub ai: AiService,
    pub sink: SharedSink,
}

impl AppState {
    /// Must be called inside the async runtime (managers spawn background tasks).
    pub fn init(data_dir: PathBuf, sink: SharedSink) -> Result<Self> {
        std::fs::create_dir_all(&data_dir).map_err(brainbox_core::AppError::storage)?;
        let vault = Arc::new(Vault::open(&data_dir)?);
        let vault_backend = vault.backend;
        let storage = Arc::new(Storage::open(&data_dir.join("brainbox.db"), vault)?);
        let settings = storage.settings().unwrap_or_default();
        let prompts = Arc::new(PromptHub::new(sink.clone()));
        let gate = Arc::new(HostKeyGate::new(storage.clone(), prompts.clone()));
        let conns = ConnectionManager::new(storage.clone(), gate, sink.clone());
        let sudo = Arc::new(SudoCache::default());
        let transfers = TransferManager::new(conns.clone(), sink.clone(), settings.transfer_concurrency as usize);
        transfers.set_min_notify_secs(settings.notifications.min_duration_secs as u64);
        Ok(Self {
            terminals: TerminalManager::new(conns.clone()),
            tunnels: TunnelManager::new(conns.clone(), storage.clone(), sink.clone()),
            monitor: Monitor::new(conns.clone(), sink.clone()),
            logs: LogStreams::new(conns.clone(), sudo.clone()),
            ai: AiService::new(conns.clone(), storage.clone(), sudo.clone()),
            data_dir,
            vault_backend,
            storage,
            conns,
            prompts,
            transfers,
            sudo,
            sink,
        })
    }

    pub async fn shutdown(&self) {
        self.logs.stop_all();
        self.terminals.close_all();
        self.tunnels.stop_all().await;
        self.conns.disconnect_all().await;
    }
}
