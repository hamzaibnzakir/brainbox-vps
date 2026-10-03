//! Connection recovery: kill the server-side SSH session processes and check
//! that the connection, a tmux-backed terminal and a remote tunnel recover.
//! Kept in its own test binary because it disrupts every `bbx` session.

mod common;

use base64::Engine;
use brainbox_core::events::{names, StreamFn};
use brainbox_core::model::*;
use brainbox_core::ssh::exec::{exec, ExecOptions};
use brainbox_core::terminal::TerminalManager;
use brainbox_core::tunnels::TunnelManager;
use common::*;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn kill_bbx_sessions() {
    let st = std::process::Command::new("pkill").args(["-KILL", "-u", "bbx", "-f", "sshd"]).status().unwrap();
    assert!(st.success(), "no sshd session processes found to kill");
}

fn text(ev: &Mutex<Vec<TerminalEvent>>) -> String {
    let mut s = Vec::new();
    for e in ev.lock().iter() {
        if let TerminalEvent::Data { data } = e {
            s.extend(base64::engine::general_purpose::STANDARD.decode(data).unwrap());
        }
    }
    String::from_utf8_lossy(&s).into_owned()
}

async fn until<F: Fn() -> bool>(f: F, secs: u64) -> bool {
    for _ in 0..(secs * 10) {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recovers_connection_terminal_and_tunnels() {
    require_ssh!();
    let h = harness();
    let mut i = server_input("recover", PORT, AuthMethod::Password);
    i.use_tmux = true;
    i.keepalive_secs = 2;
    let p = h.storage.create_server(&i).unwrap();
    h.mgr.connect(&p.id, None).await.unwrap();
    let conn = h.mgr.get(&p.id).unwrap();
    let gen0 = conn.generation();

    // Terminal inside tmux with some shell state.
    let tm = TerminalManager::new(h.mgr.clone());
    let events = Arc::new(Mutex::new(Vec::new()));
    let e2 = events.clone();
    let sink: StreamFn<TerminalEvent> = Arc::new(move |e| e2.lock().push(e));
    let name = unique("bbxtest");
    let info = tm
        .open_remote(TerminalOpenRequest { server_id: p.id.clone(), cols: 100, rows: 30, tmux_session: Some(name.clone()), command: None, cwd: None }, sink)
        .await
        .unwrap();
    assert_eq!(info.tmux_session.as_deref(), Some(name.as_str()));
    tokio::time::sleep(Duration::from_millis(800)).await;
    tm.write(&info.id, b"export BBX_STATE=survived-42\n").unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Remote tunnel that must be re-registered after reconnect.
    let echo_l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo_l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = echo_l.accept().await.unwrap();
            tokio::spawn(async move {
                let mut b = [0u8; 64];
                if let Ok(n) = s.read(&mut b).await {
                    let _ = s.write_all(&b[..n]).await;
                }
            });
        }
    });
    let rport = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let tun = TunnelManager::new(h.mgr.clone(), h.storage.clone(), h.mgr.sink().clone());
    let rt = h
        .storage
        .save_tunnel(None, &TunnelInput { server_id: p.id.clone(), name: "r".into(), kind: TunnelKind::Remote, bind_host: "127.0.0.1".into(), bind_port: rport, target_host: "127.0.0.1".into(), target_port: echo_port, auto_start: false })
        .unwrap();
    tun.start(&rt.id).await.unwrap();

    // 💥 Drop every session server-side.
    kill_bbx_sessions();

    assert!(until(|| events.lock().iter().any(|e| matches!(e, TerminalEvent::Suspended)), 15).await, "terminal suspended");
    let reconnecting = h.sink.named(names::CONNECTION_STATUS).iter().any(|v| v["state"]["state"] == "reconnecting");
    assert!(until(|| conn.is_connected() && conn.generation() > gen0, 30).await, "connection came back");
    assert!(reconnecting || h.sink.named(names::CONNECTION_STATUS).iter().any(|v| v["state"]["state"] == "reconnecting"));
    assert!(until(|| events.lock().iter().any(|e| matches!(e, TerminalEvent::Resumed)), 20).await, "terminal resumed");

    // tmux kept the shell alive: our variable is still set.
    tm.write(&info.id, b"echo VALUE=$BBX_STATE\n").unwrap();
    assert!(until(|| text(&events).contains("VALUE=survived-42"), 15).await, "tmux state lost:\n{}", text(&events));

    // Remote tunnel re-registered on the new connection.
    let ok = until(|| tun.status(&rt.id).map(|s| s.state == TunnelState::Running).unwrap_or(false), 15).await;
    assert!(ok);
    let mut got = false;
    for _ in 0..30 {
        if let Ok(mut s) = tokio::net::TcpStream::connect(("127.0.0.1", rport)).await {
            s.write_all(b"ping").await.unwrap();
            let mut b = [0u8; 4];
            if tokio::time::timeout(Duration::from_secs(2), s.read_exact(&mut b)).await.map(|r| r.is_ok()).unwrap_or(false) && &b == b"ping" {
                got = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(got, "remote forward works after reconnect");

    // Notifications were raised for disconnect and reconnect.
    let notes = h.sink.named(names::NOTIFY);
    assert!(notes.iter().any(|n| n["kind"] == "ssh_disconnected"));
    assert!(notes.iter().any(|n| n["kind"] == "ssh_reconnected"));

    // Clean up the tmux session.
    tm.close(&info.id);
    let c = h.mgr.require(&p.id).unwrap();
    let _ = exec(&c, &format!("tmux kill-session -t {name}"), ExecOptions::default()).await;
    h.mgr.disconnect(&p.id).await;
    assert!(matches!(conn.status().state, ConnectionState::Disconnected));
}
