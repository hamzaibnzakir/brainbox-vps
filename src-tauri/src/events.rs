//! Bridges core events to the webview and to native notifications.

use brainbox_core::events::{names, EventSink};
use brainbox_core::model::{AppNotification, NotificationPrefs};
use brainbox_core::storage::Storage;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub struct TauriSink {
    pub app: AppHandle,
    pub storage: OnceLock<Arc<Storage>>,
}

fn allowed(p: &NotificationPrefs, kind: &str) -> bool {
    if !p.enabled {
        return false;
    }
    match kind {
        "ssh_disconnected" => p.ssh_disconnected,
        "ssh_reconnected" => p.ssh_reconnected,
        "transfer_finished" => p.transfer_finished,
        "container_stopped" => p.container_stopped,
        "server_unreachable" => p.server_unreachable,
        "command_finished" => p.command_finished,
        _ => true,
    }
}

impl TauriSink {
    fn native(&self, n: &AppNotification) {
        let Some(storage) = self.storage.get() else { return };
        let prefs = storage.settings().map(|s| s.notifications).unwrap_or_default();
        if !allowed(&prefs, &n.kind) {
            return;
        }
        // In-app toasts cover the focused window; native toasts when in background.
        let focused = self
            .app
            .get_webview_window("main")
            .map(|w| w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false))
            .unwrap_or(false);
        if focused {
            return;
        }
        let _ = self.app.notification().builder().title(&n.title).body(&n.body).show();
    }
}

impl EventSink for TauriSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        if event == names::NOTIFY {
            if let Ok(n) = serde_json::from_value::<AppNotification>(payload.clone()) {
                self.native(&n);
            }
        }
        let _ = self.app.emit(event, payload);
    }
}
