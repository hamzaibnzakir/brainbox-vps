#![allow(dead_code)]
//! Shared harness for integration tests against real OpenSSH servers started
//! by `scripts/test-sshd.sh`. Tests are skipped unless `BBX_TEST_SSH=1`.

use brainbox_core::events::{RecordingSink, SharedSink};
use brainbox_core::model::*;
use brainbox_core::security::Vault;
use brainbox_core::ssh::hostkey::{HostKeyGate, PromptHub};
use brainbox_core::ssh::ConnectionManager;
use brainbox_core::storage::Storage;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

pub const HOST: &str = "127.0.0.1";
pub const PORT: u16 = 2222;
pub const PORT2: u16 = 2223;
pub const USER: &str = "bbx";
pub const PASS: &str = "bbxpass";
pub const KEY_ED25519: &str = "/tmp/bbx-sshd/client_ed25519";
pub const KEY_RSA_ENC: &str = "/tmp/bbx-sshd/client_rsa_enc";
pub const KEY_PASS: &str = "keypass";

pub fn enabled() -> bool {
    std::env::var("BBX_TEST_SSH").map(|v| v == "1").unwrap_or(false)
}

#[macro_export]
macro_rules! require_ssh {
    () => {
        if !common::enabled() {
            eprintln!("skipping: set BBX_TEST_SSH=1 and run scripts/test-sshd.sh");
            return;
        }
    };
}

pub struct H {
    pub storage: Arc<Storage>,
    pub mgr: Arc<ConnectionManager>,
    pub sink: Arc<RecordingSink>,
    pub prompts: Arc<PromptHub>,
    pub prompt_count: Arc<AtomicUsize>,
}

pub fn harness_with(decision: HostKeyDecision) -> H {
    let _ = env_logger_init();
    let vault = Arc::new(Vault::with_key([9u8; 32]));
    let storage = Arc::new(Storage::in_memory(vault).unwrap());
    let sink = Arc::new(RecordingSink::default());
    let shared: SharedSink = sink.clone();
    let prompts = Arc::new(PromptHub::new(shared.clone()));
    let count = Arc::new(AtomicUsize::new(0));
    let c2 = count.clone();
    prompts.set_auto_answer(Some(Arc::new(move |_p: &HostKeyPrompt| {
        c2.fetch_add(1, Ordering::SeqCst);
        decision
    })));
    let mut gate = HostKeyGate::new(storage.clone(), prompts.clone());
    gate.use_openssh_known_hosts = false;
    let mgr = ConnectionManager::new(storage.clone(), Arc::new(gate), shared);
    *mgr.max_backoff.lock() = std::time::Duration::from_millis(500);
    H { storage, mgr, sink, prompts, prompt_count: count }
}

pub fn harness() -> H {
    harness_with(HostKeyDecision::Trust)
}

fn env_logger_init() -> Option<()> {
    None
}

pub fn server_input(name: &str, port: u16, auth: AuthMethod) -> ServerInput {
    ServerInput {
        name: name.into(),
        host: HOST.into(),
        port,
        username: USER.into(),
        auth_method: auth,
        key_path: None,
        password: if auth == AuthMethod::Password { SecretUpdate::Set(PASS.into()) } else { SecretUpdate::Keep },
        passphrase: SecretUpdate::Keep,
        key_data: SecretUpdate::Keep,
        group: None,
        tags: vec![],
        favorite: false,
        color: None,
        notes: None,
        proxy: None,
        proxy_password: SecretUpdate::Keep,
        jump_host_id: None,
        keepalive_secs: 5,
        connect_timeout_secs: 10,
        auto_reconnect: true,
        use_tmux: false,
        startup_dir: None,
        startup_command: None,
    }
}

pub fn add_password_server(h: &H, name: &str) -> ServerProfile {
    h.storage.create_server(&server_input(name, PORT, AuthMethod::Password)).unwrap()
}

pub async fn connected(h: &H, name: &str) -> (ServerProfile, Arc<brainbox_core::ssh::ServerConnection>) {
    let p = add_password_server(h, name);
    h.mgr.connect(&p.id, None).await.expect("connect");
    let c = h.mgr.require(&p.id).unwrap();
    (p, c)
}

pub fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", &uuid::Uuid::new_v4().simple().to_string()[..10])
}
