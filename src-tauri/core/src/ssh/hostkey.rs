//! Host key verification.
//!
//! Trust sources, in order:
//! 1. Brainbox's own known-hosts table (SQLite)
//! 2. The user's OpenSSH `~/.ssh/known_hosts` (read-only)
//!
//! Unknown keys and *changed* keys are never accepted silently: the user is
//! asked through a [`HostKeyPrompt`] event and the handshake waits for the
//! answer (or times out and rejects).

use crate::events::{names, EventSinkExt, SharedSink};
use crate::model::{HostKeyDecision, HostKeyPrompt};
use crate::storage::Storage;
use parking_lot::Mutex;
use russh::keys::{HashAlg, PublicKey};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

type AutoAnswer = Arc<dyn Fn(&HostKeyPrompt) -> HostKeyDecision + Send + Sync>;

pub struct PromptHub {
    pending: Mutex<HashMap<String, (HostKeyPrompt, oneshot::Sender<HostKeyDecision>)>>,
    sink: SharedSink,
    auto: Mutex<Option<AutoAnswer>>,
}

impl PromptHub {
    pub fn new(sink: SharedSink) -> Self {
        Self { pending: Mutex::new(HashMap::new()), sink, auto: Mutex::new(None) }
    }

    /// Install an automatic responder (tests / headless use only).
    pub fn set_auto_answer(&self, f: Option<AutoAnswer>) {
        *self.auto.lock() = f;
    }

    pub async fn ask(&self, prompt: HostKeyPrompt) -> HostKeyDecision {
        if let Some(f) = self.auto.lock().clone() {
            return f(&prompt);
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(prompt.request_id.clone(), (prompt.clone(), tx));
        self.sink.emit(names::HOST_KEY_PROMPT, &prompt);
        let res = tokio::time::timeout(PROMPT_TIMEOUT, rx).await;
        self.pending.lock().remove(&prompt.request_id);
        match res {
            Ok(Ok(d)) => d,
            _ => HostKeyDecision::Reject,
        }
    }

    pub fn answer(&self, request_id: &str, decision: HostKeyDecision) -> bool {
        if let Some((_, tx)) = self.pending.lock().remove(request_id) {
            tx.send(decision).is_ok()
        } else {
            false
        }
    }

    /// Prompts still waiting for an answer (e.g. after the UI reloads).
    pub fn pending(&self) -> Vec<HostKeyPrompt> {
        self.pending.lock().values().map(|(p, _)| p.clone()).collect()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Trusted,
    Unknown,
    Mismatch { previous: String },
}

#[derive(Debug, Clone, Default)]
pub struct HostKeyOutcome {
    pub accepted: bool,
    pub fingerprint: String,
    pub algorithm: String,
    pub mismatch_previous: Option<String>,
    pub user_rejected: bool,
}

pub struct HostKeyGate {
    storage: Arc<Storage>,
    prompts: Arc<PromptHub>,
    /// Consult ~/.ssh/known_hosts as an additional trust source.
    pub use_openssh_known_hosts: bool,
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

impl HostKeyGate {
    pub fn new(storage: Arc<Storage>, prompts: Arc<PromptHub>) -> Self {
        Self { storage, prompts, use_openssh_known_hosts: true }
    }

    pub fn prompts(&self) -> &Arc<PromptHub> {
        &self.prompts
    }

    pub fn verdict(&self, host: &str, port: u16, key: &PublicKey) -> Verdict {
        let fp = fingerprint(key);
        let algo = key.algorithm().as_str().to_string();
        let known = self.storage.known_host_keys(host, port).unwrap_or_default();
        if known.iter().any(|k| k.fingerprint == fp) {
            return Verdict::Trusted;
        }
        // A different key of the SAME algorithm is a real change. A key of a
        // different algorithm is just a new key type (e.g. ed25519 vs rsa).
        if let Some(prev) = known.iter().find(|k| k.algorithm == algo) {
            return Verdict::Mismatch { previous: prev.fingerprint.clone() };
        }
        if self.use_openssh_known_hosts {
            match russh::keys::check_known_hosts(host, port, key) {
                Ok(true) => return Verdict::Trusted,
                Err(russh::keys::Error::KeyChanged { line }) => {
                    return Verdict::Mismatch { previous: format!("(key in ~/.ssh/known_hosts line {line})") }
                }
                _ => {}
            }
        }
        Verdict::Unknown
    }

    pub async fn check(&self, server_id: &str, host: &str, port: u16, key: &PublicKey) -> HostKeyOutcome {
        let fp = fingerprint(key);
        let algo = key.algorithm().as_str().to_string();
        let mut out = HostKeyOutcome { fingerprint: fp.clone(), algorithm: algo.clone(), ..Default::default() };
        let verdict = self.verdict(host, port, key);
        if verdict == Verdict::Trusted {
            out.accepted = true;
            return out;
        }
        let previous = match &verdict {
            Verdict::Mismatch { previous } => Some(previous.clone()),
            _ => None,
        };
        out.mismatch_previous = previous.clone();
        let decision = self
            .prompts
            .ask(HostKeyPrompt {
                request_id: uuid::Uuid::new_v4().to_string(),
                server_id: server_id.to_string(),
                host: host.to_string(),
                port,
                algorithm: algo.clone(),
                fingerprint: fp.clone(),
                previous_fingerprint: previous,
            })
            .await;
        match decision {
            HostKeyDecision::Trust => {
                if let Err(e) = self.storage.trust_host_key(host, port, &algo, &fp) {
                    log::error!("failed to store host key: {e}");
                }
                out.accepted = true;
            }
            HostKeyDecision::Once => out.accepted = true,
            HostKeyDecision::Reject => out.user_rejected = true,
        }
        out
    }
}
