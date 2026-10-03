//! System tray icon and menu.

use crate::state::AppState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Brainbox VPS", true, None::<&str>)?;
    let palette = MenuItem::with_id(app, "palette", "Command Palette…", true, None::<&str>)?;
    let transfers = MenuItem::with_id(app, "transfers", "Transfers", true, None::<&str>)?;
    let disconnect = MenuItem::with_id(app, "disconnect_all", "Disconnect all servers", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &palette, &transfers, &sep, &disconnect, &sep2, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Brainbox VPS")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => show(app),
            "palette" => {
                show(app);
                let _ = app.emit("app://command", "palette");
            }
            "transfers" => {
                show(app);
                let _ = app.emit("app://command", "transfers");
            }
            "disconnect_all" => {
                if let Some(s) = app.try_state::<AppState>() {
                    tauri::async_runtime::block_on(s.conns.disconnect_all());
                }
            }
            "quit" => {
                if let Some(s) = app.try_state::<AppState>() {
                    tauri::async_runtime::block_on(s.shutdown());
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
