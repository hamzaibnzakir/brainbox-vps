//! Event plumbing that keeps the core independent from Tauri.
//!
//! The desktop layer implements [`EventSink`] with `AppHandle::emit`; tests use
//! [`RecordingSink`].

use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;

pub mod names {
    pub const CONNECTION_STATUS: &str = "connection://status";
    pub const HOST_KEY_PROMPT: &str = "connection://host-key";
    pub const METRICS: &str = "monitor://metrics";
    pub const TRANSFER: &str = "transfer://update";
    pub const TUNNEL: &str = "tunnel://status";
    pub const BROADCAST: &str = "broadcast://result";
    pub const NOTIFY: &str = "app://notify";
}

pub trait EventSink: Send + Sync + 'static {
    fn emit_json(&self, event: &str, payload: serde_json::Value);
}

pub trait EventSinkExt {
    fn emit<T: Serialize>(&self, event: &str, payload: &T);
}

impl<S: EventSink + ?Sized> EventSinkExt for S {
    fn emit<T: Serialize>(&self, event: &str, payload: &T) {
        match serde_json::to_value(payload) {
            Ok(v) => self.emit_json(event, v),
            Err(e) => log::error!("failed to serialize event {event}: {e}"),
        }
    }
}

pub type SharedSink = Arc<dyn EventSink>;

/// Discards everything.
pub struct NullSink;
impl EventSink for NullSink {
    fn emit_json(&self, _event: &str, _payload: serde_json::Value) {}
}

/// Records every event (for tests).
#[derive(Default)]
pub struct RecordingSink {
    pub events: Mutex<Vec<(String, serde_json::Value)>>,
}

impl RecordingSink {
    pub fn named(&self, name: &str) -> Vec<serde_json::Value> {
        self.events.lock().iter().filter(|(n, _)| n == name).map(|(_, v)| v.clone()).collect()
    }
}

impl EventSink for RecordingSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        self.events.lock().push((event.to_string(), payload));
    }
}

/// Per-stream callback (terminal output, log lines…).
pub type StreamFn<T> = Arc<dyn Fn(T) + Send + Sync + 'static>;
