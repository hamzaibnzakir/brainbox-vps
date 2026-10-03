//! Brainbox VPS desktop shell (Tauri 2).

mod commands;
mod events;
mod state;
mod tray;

use events::TauriSink;
use state::AppState;
use std::sync::{Arc, OnceLock};
use tauri::{Manager, WindowEvent};

fn data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Ok(d) = std::env::var("BRAINBOX_DATA_DIR") {
        return d.into();
    }
    app.path().app_data_dir().unwrap_or_else(|_| dirs::data_dir().unwrap_or_default().join("Brainbox VPS"))
}

fn init_logging(dir: &std::path::Path) {
    use simplelog::*;
    let _ = std::fs::create_dir_all(dir.join("logs"));
    let file = std::fs::File::create(dir.join("logs").join("brainbox.log"));
    let cfg = ConfigBuilder::new().add_filter_ignore_str("russh").add_filter_ignore_str("tao").add_filter_ignore_str("wry").build();
    let mut loggers: Vec<Box<dyn SharedLogger>> = vec![];
    if let Ok(f) = file {
        loggers.push(WriteLogger::new(LevelFilter::Info, cfg.clone(), f));
    }
    #[cfg(debug_assertions)]
    loggers.push(TermLogger::new(LevelFilter::Info, cfg, TerminalMode::Mixed, ColorChoice::Auto));
    let _ = CombinedLogger::init(loggers);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .setup(|app| {
            // Synchronous commands run on the main thread; background tasks they start
            // must land on Tauri's Tokio runtime.
            let tauri::async_runtime::RuntimeHandle::Tokio(rt) = tauri::async_runtime::handle();
            brainbox_core::rt::set_handle(rt);
            let handle = app.handle().clone();
            let dir = data_dir(&handle);
            init_logging(&dir);
            log::info!("Brainbox VPS {} starting; data dir {}", app.package_info().version, dir.display());
            let sink = Arc::new(TauriSink { app: handle.clone(), storage: OnceLock::new() });
            let state = tauri::async_runtime::block_on(async { AppState::init(dir.clone(), sink.clone()) });
            let state = match state {
                Ok(s) => s,
                Err(e) => {
                    log::error!("startup failed: {e:?}");
                    rfd_fallback(&format!("{}\n\n{}\n\n{}", e.title, e.message, e.details.unwrap_or_default()));
                    std::process::exit(1);
                }
            };
            let _ = sink.storage.set(state.storage.clone());
            app.manage(state);
            tray::create(&handle)?;
            let minimized = std::env::args().any(|a| a == "--minimized");
            if let Some(w) = app.get_webview_window("main") {
                if !minimized {
                    let _ = w.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let to_tray = app.try_state::<AppState>().and_then(|s| s.storage.settings().ok()).map(|s| s.close_to_tray).unwrap_or(false);
                if to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    // Close SSH sessions cleanly before exiting.
                    if let Some(s) = app.try_state::<AppState>() {
                        tauri::async_runtime::block_on(s.shutdown());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // servers & connections
            commands::servers::servers_list,
            commands::servers::server_create,
            commands::servers::server_update,
            commands::servers::server_delete,
            commands::servers::server_duplicate,
            commands::servers::server_set_favorite,
            commands::servers::server_rename,
            commands::servers::servers_set_group,
            commands::servers::servers_reorder,
            commands::servers::ssh_config_scan,
            commands::servers::ssh_config_import,
            commands::servers::known_hosts_list,
            commands::servers::known_host_forget,
            commands::servers::connect,
            commands::servers::disconnect,
            commands::servers::connection_statuses,
            commands::servers::host_key_answer,
            commands::servers::host_key_pending,
            // terminals
            commands::terminal::terminal_open,
            commands::terminal::terminal_open_local,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::local_shells,
            commands::terminal::tmux_sessions,
            // files & transfers
            commands::files::sftp_home,
            commands::files::sftp_list,
            commands::files::sftp_stat,
            commands::files::sftp_mkdir,
            commands::files::sftp_create_file,
            commands::files::sftp_rename,
            commands::files::sftp_delete,
            commands::files::sftp_copy,
            commands::files::sftp_move,
            commands::files::sftp_chmod,
            commands::files::sftp_read_text,
            commands::files::sftp_write_text,
            commands::files::sftp_search,
            commands::files::sftp_dir_size,
            commands::files::local_home,
            commands::files::local_list,
            commands::files::local_stat,
            commands::files::local_mkdir,
            commands::files::local_create_file,
            commands::files::local_rename,
            commands::files::local_delete,
            commands::files::local_copy,
            commands::files::local_move,
            commands::files::local_search,
            commands::files::local_open,
            commands::files::local_reveal,
            commands::files::open_url,
            commands::files::transfer_start,
            commands::files::transfer_start_many,
            commands::files::transfers_list,
            commands::files::transfer_pause,
            commands::files::transfer_resume,
            commands::files::transfer_retry,
            commands::files::transfer_cancel,
            commands::files::transfers_clear_finished,
            // monitoring & tools
            commands::tools::monitor_start,
            commands::tools::monitor_stop,
            commands::tools::monitor_history,
            commands::tools::system_info,
            commands::tools::processes_list,
            commands::tools::process_details,
            commands::tools::process_signal,
            commands::tools::ports_list,
            commands::tools::services_list,
            commands::tools::service_status,
            commands::tools::service_action,
            commands::tools::docker_status,
            commands::tools::docker_containers,
            commands::tools::docker_images,
            commands::tools::docker_volumes,
            commands::tools::docker_networks,
            commands::tools::docker_stats,
            commands::tools::docker_inspect,
            commands::tools::docker_container_action,
            commands::tools::docker_remove_image,
            commands::tools::docker_remove_volume,
            commands::tools::docker_exec_command,
            commands::tools::git_discover,
            commands::tools::git_status,
            commands::tools::git_branches,
            commands::tools::git_log,
            commands::tools::git_diff,
            commands::tools::git_show,
            commands::tools::git_action,
            commands::tools::git_checkout,
            commands::tools::logs_start,
            commands::tools::logs_stop,
            commands::tools::logs_discover,
            commands::tools::logs_export,
            commands::tools::sudo_remember,
            // tunnels, commands, broadcast, workspaces, settings, AI
            commands::app::tunnels_list,
            commands::app::tunnel_statuses,
            commands::app::tunnel_save,
            commands::app::tunnel_delete,
            commands::app::tunnel_start,
            commands::app::tunnel_stop,
            commands::app::snippets_list,
            commands::app::snippet_save,
            commands::app::snippet_delete,
            commands::app::command_assess,
            commands::app::command_run,
            commands::app::broadcast_run,
            commands::app::workspaces_list,
            commands::app::workspace_create,
            commands::app::workspace_save,
            commands::app::workspace_delete,
            commands::app::ui_state_get,
            commands::app::ui_state_set,
            commands::app::settings_get,
            commands::app::settings_save,
            commands::app::ai_set_key,
            commands::app::ai_new_chat,
            commands::app::ai_send,
            commands::app::ai_decide,
            commands::app::ai_delete_chat,
            commands::app::app_info,
            commands::app::app_quit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Brainbox VPS");
}

/// Last-resort startup error display (before the UI exists).
fn rfd_fallback(msg: &str) {
    eprintln!("Brainbox VPS failed to start:\n{msg}");
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        let text: Vec<u16> = OsStr::new(msg).encode_wide().chain(Some(0)).collect();
        let title: Vec<u16> = OsStr::new("Brainbox VPS").encode_wide().chain(Some(0)).collect();
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, utype: u32) -> i32;
        }
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
        }
    }
}
