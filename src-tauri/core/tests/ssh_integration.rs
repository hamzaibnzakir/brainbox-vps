//! Integration tests against real OpenSSH servers (see scripts/test-sshd.sh).

mod common;

use brainbox_core::error::ErrorCode;
use brainbox_core::events::StreamFn;
use brainbox_core::model::*;
use brainbox_core::sftp::{ops, transfer::TransferManager};
use brainbox_core::ssh::auth::Credentials;
use brainbox_core::ssh::exec::{exec, exec_stream, ExecOptions};
use brainbox_core::security::SecretString;
use brainbox_core::terminal::TerminalManager;
use brainbox_core::tunnels::TunnelManager;
use base64::Engine;
use common::*;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn password_auth_exec_and_host_key_trust() {
    require_ssh!();
    let h = harness();
    let (p, c) = connected(&h, "pw").await;
    assert_eq!(h.prompt_count.load(std::sync::atomic::Ordering::SeqCst), 1, "unknown key prompts once");
    let known = h.storage.known_host_keys(HOST, PORT).unwrap();
    assert_eq!(known.len(), 1);
    assert!(known[0].fingerprint.starts_with("SHA256:"));

    let out = exec(&c, "whoami; echo err >&2; exit 3", ExecOptions::default()).await.unwrap();
    assert_eq!(out.stdout.trim(), "bbx");
    assert_eq!(out.stderr.trim(), "err");
    assert_eq!(out.exit_code, Some(3));

    // Reconnect: key is now trusted, no new prompt.
    h.mgr.disconnect(&p.id).await;
    assert!(h.mgr.require(&p.id).is_err());
    h.mgr.connect(&p.id, None).await.unwrap();
    assert_eq!(h.prompt_count.load(std::sync::atomic::Ordering::SeqCst), 1);
    let st = h.mgr.get(&p.id).unwrap().status();
    assert!(matches!(st.state, ConnectionState::Connected { .. }));
    assert!(st.fingerprint.unwrap().contains("SHA256:"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auth_failures_are_human() {
    require_ssh!();
    let h = harness();
    let mut i = server_input("bad", PORT, AuthMethod::Password);
    i.password = SecretUpdate::Set("wrong".into());
    let p = h.storage.create_server(&i).unwrap();
    let e = h.mgr.connect(&p.id, None).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::AuthFailed, "{e:?}");

    i.password = SecretUpdate::Clear;
    let p2 = h.storage.create_server(&i).unwrap();
    let e = h.mgr.connect(&p2.id, None).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NeedPassword);
    // One-time password supplied by the user works without saving it.
    let creds = Credentials { password: Some(SecretString::new(PASS)), ..Default::default() };
    h.mgr.connect(&p2.id, Some(creds)).await.unwrap();
    assert!(!h.storage.get_server(&p2.id).unwrap().has_password);

    let mut r = server_input("refused", 1, AuthMethod::Password);
    r.connect_timeout_secs = 3;
    let p3 = h.storage.create_server(&r).unwrap();
    let e = h.mgr.connect(&p3.id, None).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::ConnectionRefused);
    assert_eq!(e.message, "Unable to connect to SSH on port 1.");
    assert!(!e.causes.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn key_auth_file_and_imported_with_passphrase() {
    require_ssh!();
    let h = harness();
    let mut i = server_input("ed", PORT, AuthMethod::Key);
    i.key_path = Some(KEY_ED25519.into());
    let p = h.storage.create_server(&i).unwrap();
    h.mgr.connect(&p.id, None).await.unwrap();

    // Imported, passphrase-protected RSA key.
    let pem = std::fs::read_to_string(KEY_RSA_ENC).unwrap();
    let mut k = server_input("rsa", PORT, AuthMethod::Key);
    k.key_data = SecretUpdate::Set(pem.clone());
    assert_eq!(h.storage.create_server(&k).unwrap_err().code, ErrorCode::NeedPassphrase);
    k.passphrase = SecretUpdate::Set(KEY_PASS.into());
    let p2 = h.storage.create_server(&k).unwrap();
    assert!(p2.has_key_data && p2.has_passphrase);
    h.mgr.connect(&p2.id, None).await.unwrap();

    // Key file needing a passphrase that isn't saved → asks for it; wrong one → clear error.
    let mut f = server_input("rsa-file", PORT, AuthMethod::Key);
    f.key_path = Some(KEY_RSA_ENC.into());
    let p3 = h.storage.create_server(&f).unwrap();
    assert_eq!(h.mgr.connect(&p3.id, None).await.unwrap_err().code, ErrorCode::NeedPassphrase);
    let bad = Credentials { passphrase: Some(SecretString::new("nope")), ..Default::default() };
    assert_eq!(h.mgr.connect(&p3.id, Some(bad)).await.unwrap_err().code, ErrorCode::BadPassphrase);
    let good = Credentials { passphrase: Some(SecretString::new(KEY_PASS)), ..Default::default() };
    h.mgr.connect(&p3.id, Some(good)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_key_mismatch_blocks_and_reject_cancels() {
    require_ssh!();
    let h = harness();
    let p = add_password_server(&h, "mitm");
    h.storage.trust_host_key(HOST, PORT, "ssh-ed25519", "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
    let hr = harness_with(HostKeyDecision::Reject);
    // Same storage semantics, but the user rejects the changed key.
    let p_r = add_password_server(&hr, "mitm2");
    hr.storage.trust_host_key(HOST, PORT, "ssh-ed25519", "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
    let e = hr.mgr.connect(&p_r.id, None).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::HostKeyMismatch, "{e:?}");
    assert!(e.details.unwrap().contains("SHA256:AAAA"));

    // Accepting the changed key ("Trust") replaces the stored one.
    h.mgr.connect(&p.id, None).await.unwrap();
    let k = h.storage.known_host_keys(HOST, PORT).unwrap();
    assert_eq!(k.len(), 1);
    assert_ne!(k[0].fingerprint, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

    let hx = harness_with(HostKeyDecision::Reject);
    let p3 = add_password_server(&hx, "new");
    let e = hx.mgr.connect(&p3.id, None).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::HostKeyRejected);
    assert!(hx.storage.known_host_keys(HOST, PORT).unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jump_host_chain() {
    require_ssh!();
    let h = harness();
    let jump = add_password_server(&h, "bastion");
    let mut i = server_input("private", PORT2, AuthMethod::Password);
    i.jump_host_id = Some(jump.id.clone());
    let target = h.storage.create_server(&i).unwrap();
    h.mgr.connect(&target.id, None).await.unwrap();
    let c = h.mgr.require(&target.id).unwrap();
    let out = exec(&c, "echo $SSH_CONNECTION", ExecOptions::default()).await.unwrap();
    // The private server sees the connection arriving on port 2223.
    assert!(out.stdout.trim().ends_with("2223"), "{}", out.stdout);
    assert!(h.mgr.get(&jump.id).unwrap().is_connected(), "jump host stays connected");

    // Self-referencing jump is rejected at save time.
    let mut bad = server_input("loop", PORT, AuthMethod::Password);
    bad.jump_host_id = Some(target.id.clone());
    assert!(h.storage.update_server(&target.id, &bad).is_err());
}

fn collect_sink() -> (StreamFn<TerminalEvent>, Arc<Mutex<Vec<TerminalEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let e2 = events.clone();
    (Arc::new(move |e| e2.lock().push(e)), events)
}

fn output_text(events: &Mutex<Vec<TerminalEvent>>) -> String {
    let mut s = Vec::new();
    for e in events.lock().iter() {
        if let TerminalEvent::Data { data } = e {
            s.extend(base64::engine::general_purpose::STANDARD.decode(data).unwrap());
        }
    }
    String::from_utf8_lossy(&s).into_owned()
}

async fn wait_for(events: &Mutex<Vec<TerminalEvent>>, needle: &str, secs: u64) -> bool {
    for _ in 0..(secs * 10) {
        if output_text(events).contains(needle) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terminal_shell_io_resize_exit() {
    require_ssh!();
    let h = harness();
    let (p, _c) = connected(&h, "term").await;
    let tm = TerminalManager::new(h.mgr.clone());
    let (sink, events) = collect_sink();
    let info = tm
        .open_remote(TerminalOpenRequest { server_id: p.id.clone(), cols: 100, rows: 30, tmux_session: None, command: None, cwd: Some("/tmp".into()) }, sink)
        .await
        .unwrap();
    tm.write(&info.id, b"echo \"cols=$(tput cols) pwd=$(pwd) term=$TERM\"\n").unwrap();
    assert!(wait_for(&events, "cols=100 pwd=/tmp term=xterm-256color", 10).await, "{}", output_text(&events));
    tm.resize(&info.id, 132, 40).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    tm.write(&info.id, b"echo size=$(stty size)\n").unwrap();
    assert!(wait_for(&events, "size=40 132", 10).await);
    // Unicode survives intact.
    tm.write(&info.id, "echo 'héllo 🚀 世界'\n".as_bytes()).unwrap();
    assert!(wait_for(&events, "héllo 🚀 世界", 10).await);
    tm.write(&info.id, b"exit 7\n").unwrap();
    for _ in 0..50 {
        if events.lock().iter().any(|e| matches!(e, TerminalEvent::Exit { .. })) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(events.lock().iter().any(|e| matches!(e, TerminalEvent::Exit { code: Some(7) })));
    assert!(tm.list().is_empty());

    // Exec-mode terminal (used for `docker exec -it`) works too.
    let (sink2, ev2) = collect_sink();
    tm.open_remote(TerminalOpenRequest { server_id: p.id.clone(), cols: 80, rows: 24, tmux_session: None, command: Some("printf 'exec-mode-ok'".into()), cwd: None }, sink2)
        .await
        .unwrap();
    assert!(wait_for(&ev2, "exec-mode-ok", 10).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sftp_operations_and_atomic_save() {
    require_ssh!();
    let h = harness();
    let (_p, c) = connected(&h, "sftp").await;
    let home = ops::home_dir(&c).await.unwrap();
    assert_eq!(home, "/home/bbx");
    let dir = format!("{home}/{}", unique("bbx-t"));
    ops::mkdir(&c, &dir).await.unwrap();
    assert_eq!(ops::mkdir(&c, &dir).await.unwrap_err().code, ErrorCode::AlreadyExists);

    let f = format!("{dir}/app.env");
    ops::create_file(&c, &f).await.unwrap();
    ops::chmod(&c, &f, 0o640).await.unwrap();
    let saved = ops::write_text(&c, &f, "A=1\nB=é\n", "utf-8", None).await.unwrap();
    assert_eq!(saved.permissions, Some(0o640), "atomic save keeps permissions");
    let t = ops::read_text(&c, &f).await.unwrap();
    assert_eq!(t.content, "A=1\nB=é\n");
    assert_eq!(t.encoding, "utf-8");

    // Conflict detection: file changed on the server after opening.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    exec(&c, &format!("echo C=3 >> {f}"), ExecOptions::default()).await.unwrap();
    let e = ops::write_text(&c, &f, "mine", "utf-8", t.modified).await.unwrap_err();
    assert_eq!(e.title, "File changed on the server");
    // No temp files left behind.
    let listing = ops::list_dir(&c, &dir).await.unwrap();
    assert_eq!(listing.entries.len(), 1, "{:?}", listing.entries.iter().map(|e| &e.name).collect::<Vec<_>>());

    ops::mkdir(&c, &format!("{dir}/sub")).await.unwrap();
    exec(&c, &format!("ln -s {dir}/sub {dir}/link; mkdir -p {dir}/sub/deep; echo x > {dir}/sub/deep/z.txt"), ExecOptions::default()).await.unwrap();
    let l = ops::list_dir(&c, &dir).await.unwrap();
    let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["link", "sub", "app.env"], "folders (and links to folders) first");
    assert!(l.entries[0].link_is_dir);

    ops::rename(&c, &f, &format!("{dir}/sub/app.env")).await.unwrap();
    assert_eq!(ops::rename(&c, &format!("{dir}/sub/app.env"), &format!("{dir}/sub/deep")).await.unwrap_err().code, ErrorCode::AlreadyExists);
    ops::copy(&c, &format!("{dir}/sub"), &format!("{dir}/sub2")).await.unwrap();
    let found = ops::search(&c, &dir, "Z.TX", 50).await.unwrap();
    assert_eq!(found.len(), 2);
    assert!(ops::dir_size(&c, &dir).await.unwrap() > 0);

    let bin = format!("{dir}/bin.dat");
    exec(&c, &format!("head -c 100 /dev/zero > {bin}"), ExecOptions::default()).await.unwrap();
    assert_eq!(ops::read_text(&c, &bin).await.unwrap_err().title, "Binary file");

    let n = ops::delete(&c, std::slice::from_ref(&dir)).await.unwrap();
    assert!(n >= 8);
    assert!(!ops::exists(&c, &dir).await.unwrap());
    assert!(ops::delete(&c, &["/".into()]).await.is_err());
}

fn sha(path: &std::path::Path) -> String {
    let out = std::process::Command::new("sha256sum").arg(path).output().unwrap();
    String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap().to_string()
}

async fn wait_state(tm: &TransferManager, id: &str, want: TransferState, secs: u64) -> TransferInfo {
    for _ in 0..(secs * 20) {
        let i = tm.get(id).unwrap();
        if i.state == want {
            return i;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("transfer never reached {want:?}: {:?}", tm.get(id).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn transfers_pause_resume_cancel_dirs() {
    require_ssh!();
    let h = harness();
    let (p, c) = connected(&h, "xfer").await;
    let tmp = tempfile::tempdir().unwrap();
    let big = tmp.path().join("big.bin");
    let mut data = vec![0u8; 24 * 1024 * 1024];
    for (i, b) in data.iter_mut().enumerate() {
        *b = (i * 31 % 251) as u8;
    }
    std::fs::write(&big, &data).unwrap();
    let remote_dir = format!("/home/bbx/{}", unique("xfer"));
    let tm = TransferManager::new(h.mgr.clone(), h.mgr.sink().clone(), 2);
    tm.set_min_notify_secs(0);

    // Upload with pause/resume.
    let up = tm
        .enqueue(TransferRequest { server_id: p.id.clone(), direction: TransferDirection::Upload, local_path: big.to_string_lossy().into(), remote_path: format!("{remote_dir}/big.bin"), overwrite: false })
        .unwrap();
    loop {
        let i = tm.get(&up.id).unwrap();
        if i.transferred_bytes > 2 * 1024 * 1024 {
            break;
        }
        assert_ne!(i.state, TransferState::Failed, "{:?}", i.error);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tm.pause(&up.id).unwrap();
    let paused = wait_state(&tm, &up.id, TransferState::Paused, 20).await;
    assert!(paused.transferred_bytes < paused.total_bytes, "paused mid-way");
    assert!(ops::exists(&c, &format!("{remote_dir}/big.bin.bbxpart")).await.unwrap());
    assert!(!ops::exists(&c, &format!("{remote_dir}/big.bin")).await.unwrap(), "final name only appears when complete");
    tm.resume(&up.id).unwrap();
    let done = wait_state(&tm, &up.id, TransferState::Completed, 120).await;
    assert_eq!(done.transferred_bytes, data.len() as u64);
    let rsum = exec(&c, &format!("sha256sum {remote_dir}/big.bin | cut -d' ' -f1"), ExecOptions::default()).await.unwrap();
    assert_eq!(rsum.stdout.trim(), sha(&big), "content intact after resume");

    // Overwrite protection.
    let dup = tm
        .enqueue(TransferRequest { server_id: p.id.clone(), direction: TransferDirection::Upload, local_path: big.to_string_lossy().into(), remote_path: format!("{remote_dir}/big.bin"), overwrite: false })
        .unwrap();
    let failed = wait_state(&tm, &dup.id, TransferState::Failed, 20).await;
    assert_eq!(failed.error.unwrap().code, ErrorCode::AlreadyExists);

    // Download back and compare.
    let back = tmp.path().join("back.bin");
    let dl = tm
        .enqueue(TransferRequest { server_id: p.id.clone(), direction: TransferDirection::Download, local_path: back.to_string_lossy().into(), remote_path: format!("{remote_dir}/big.bin"), overwrite: false })
        .unwrap();
    wait_state(&tm, &dl.id, TransferState::Completed, 120).await;
    assert_eq!(sha(&back), sha(&big));

    // Cancel removes partial files.
    let cancel_me = tm
        .enqueue(TransferRequest { server_id: p.id.clone(), direction: TransferDirection::Download, local_path: tmp.path().join("c.bin").to_string_lossy().into(), remote_path: format!("{remote_dir}/big.bin"), overwrite: true })
        .unwrap();
    loop {
        let i = tm.get(&cancel_me.id).unwrap();
        if i.transferred_bytes > 0 || i.state == TransferState::Completed {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tm.cancel(&cancel_me.id).await.unwrap();
    let st = tm.get(&cancel_me.id).unwrap().state;
    if st != TransferState::Completed {
        wait_state(&tm, &cancel_me.id, TransferState::Cancelled, 20).await;
        assert!(!tmp.path().join("c.bin.bbxpart").exists());
        assert!(!tmp.path().join("c.bin").exists());
    }

    // Directory upload & download.
    let tree = tmp.path().join("site");
    std::fs::create_dir_all(tree.join("css/deep")).unwrap();
    std::fs::write(tree.join("index.html"), "<h1>hi</h1>").unwrap();
    std::fs::write(tree.join("css/app.css"), "body{}").unwrap();
    std::fs::write(tree.join("css/deep/x.txt"), "x").unwrap();
    std::fs::create_dir_all(tree.join("empty")).unwrap();
    let du = tm
        .enqueue(TransferRequest { server_id: p.id.clone(), direction: TransferDirection::Upload, local_path: tree.to_string_lossy().into(), remote_path: format!("{remote_dir}/site"), overwrite: false })
        .unwrap();
    let info = wait_state(&tm, &du.id, TransferState::Completed, 60).await;
    assert!(info.is_dir);
    assert_eq!(info.files_total, 3);
    let ls = exec(&c, &format!("cd {remote_dir}/site && find . | sort"), ExecOptions::default()).await.unwrap();
    assert_eq!(ls.stdout, ".\n./css\n./css/app.css\n./css/deep\n./css/deep/x.txt\n./empty\n./index.html\n");
    let dd = tm
        .enqueue(TransferRequest { server_id: p.id.clone(), direction: TransferDirection::Download, local_path: tmp.path().join("site-copy").to_string_lossy().into(), remote_path: format!("{remote_dir}/site"), overwrite: false })
        .unwrap();
    wait_state(&tm, &dd.id, TransferState::Completed, 60).await;
    assert_eq!(std::fs::read_to_string(tmp.path().join("site-copy/css/deep/x.txt")).unwrap(), "x");
    assert!(tmp.path().join("site-copy/empty").is_dir());

    assert!(!h.sink.named(brainbox_core::events::names::TRANSFER).is_empty());
    tm.clear_finished();
    ops::delete(&c, &[remote_dir]).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exec_stream_follows_and_cancels() {
    require_ssh!();
    let h = harness();
    let (_p, c) = connected(&h, "stream").await;
    let f = format!("/tmp/{}.log", unique("bbx"));
    exec(&c, &format!("printf 'one\\ntwo\\n' > {f}"), ExecOptions::default()).await.unwrap();
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let ended = Arc::new(Mutex::new(false));
    let (l2, e2) = (lines.clone(), ended.clone());
    let cancel = CancellationToken::new();
    let c2 = c.clone();
    let cmd = format!("tail -n 10 -F {f}");
    let cc = cancel.clone();
    let task = tokio::spawn(async move {
        exec_stream(&c2, &cmd, true, cc, Arc::new(move |ev| match ev {
            StreamEvent::Lines { lines } => l2.lock().extend(lines),
            StreamEvent::End { .. } => *e2.lock() = true,
            _ => {}
        }))
        .await
    });
    tokio::time::sleep(Duration::from_millis(800)).await;
    exec(&c, &format!("echo three >> {f}"), ExecOptions::default()).await.unwrap();
    for _ in 0..50 {
        if lines.lock().len() >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(*lines.lock(), vec!["one", "two", "three"]);
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("stream stops on cancel").unwrap().unwrap();
    assert!(*ended.lock());
    // The remote tail process is gone.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let ps = exec(&c, &format!("pgrep -f '[t]ail -n 10 -F {f}' || true"), ExecOptions::default()).await.unwrap();
    assert!(ps.stdout.trim().is_empty(), "tail still running: {}", ps.stdout);
}

async fn echo_server() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = l.accept().await.unwrap();
            tokio::spawn(async move {
                let mut b = [0u8; 1024];
                loop {
                    match s.read(&mut b).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut out = b"echo:".to_vec();
                            out.extend_from_slice(&b[..n]);
                            if s.write_all(&out).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    port
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

async fn roundtrip(port: u16, msg: &[u8]) -> Vec<u8> {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(msg).await.unwrap();
    let mut buf = vec![0u8; msg.len() + 5];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut buf)).await.unwrap().unwrap();
    buf
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tunnels_local_remote_dynamic() {
    require_ssh!();
    let h = harness();
    let (p, _c) = connected(&h, "tun").await;
    let tm = TunnelManager::new(h.mgr.clone(), h.storage.clone(), h.mgr.sink().clone());
    let echo = echo_server().await;

    // -L
    let lport = free_port();
    let lt = h.storage.save_tunnel(None, &TunnelInput { server_id: p.id.clone(), name: "local".into(), kind: TunnelKind::Local, bind_host: "127.0.0.1".into(), bind_port: lport, target_host: "127.0.0.1".into(), target_port: echo, auto_start: false }).unwrap();
    let st = tm.start(&lt.id).await.unwrap();
    assert_eq!(st.state, TunnelState::Running);
    assert_eq!(roundtrip(lport, b"hello").await, b"echo:hello");
    // Port already in use → clear message.
    let lt2 = h.storage.save_tunnel(None, &TunnelInput { server_id: p.id.clone(), name: "dup".into(), kind: TunnelKind::Local, bind_host: "127.0.0.1".into(), bind_port: lport, target_host: "127.0.0.1".into(), target_port: echo, auto_start: false }).unwrap();
    assert_eq!(tm.start(&lt2.id).await.unwrap_err().title, "Port in use");

    // -D (SOCKS5)
    let dport = free_port();
    let dt = h.storage.save_tunnel(None, &TunnelInput { server_id: p.id.clone(), name: "socks".into(), kind: TunnelKind::Dynamic, bind_host: "127.0.0.1".into(), bind_port: dport, target_host: "".into(), target_port: 0, auto_start: false }).unwrap();
    tm.start(&dt.id).await.unwrap();
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", dport)).await.unwrap();
    brainbox_core::ssh::transport::socks5_handshake(&mut s, None, None, "127.0.0.1", echo).await.unwrap();
    s.write_all(b"via-socks").await.unwrap();
    let mut b = vec![0u8; 14];
    s.read_exact(&mut b).await.unwrap();
    assert_eq!(b, b"echo:via-socks");

    // -R : the server listens; we connect to it from "the server side" (same machine here).
    let rport = free_port();
    let rt = h.storage.save_tunnel(None, &TunnelInput { server_id: p.id.clone(), name: "remote".into(), kind: TunnelKind::Remote, bind_host: "127.0.0.1".into(), bind_port: rport, target_host: "127.0.0.1".into(), target_port: echo, auto_start: false }).unwrap();
    tm.start(&rt.id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(roundtrip(rport, b"rev").await, b"echo:rev");

    let stats = tm.status(&lt.id).unwrap();
    assert!(stats.bytes_in >= 10 && stats.bytes_out >= 5, "{stats:?}");
    tm.stop(&lt.id).await;
    tm.stop(&rt.id).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", lport)).await.is_err(), "listener closed after stop");
    assert!(tm.status(&lt.id).is_none());
    tm.stop_all().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn socks5_proxy_transport() {
    require_ssh!();
    // Use a Brainbox dynamic tunnel as the SOCKS proxy for a second connection.
    let h = harness();
    let (p, _c) = connected(&h, "proxy-base").await;
    let tm = TunnelManager::new(h.mgr.clone(), h.storage.clone(), h.mgr.sink().clone());
    let dport = free_port();
    let dt = h.storage.save_tunnel(None, &TunnelInput { server_id: p.id.clone(), name: "s".into(), kind: TunnelKind::Dynamic, bind_host: "127.0.0.1".into(), bind_port: dport, target_host: "".into(), target_port: 0, auto_start: false }).unwrap();
    tm.start(&dt.id).await.unwrap();
    let mut i = server_input("via-proxy", PORT2, AuthMethod::Password);
    i.proxy = Some(ProxyConfig { kind: ProxyKind::Socks5, host: "127.0.0.1".into(), port: dport, username: None, has_password: false });
    let p2 = h.storage.create_server(&i).unwrap();
    h.mgr.connect(&p2.id, None).await.unwrap();
    let out = exec(&h.mgr.require(&p2.id).unwrap(), "echo proxied", ExecOptions::default()).await.unwrap();
    assert_eq!(out.stdout.trim(), "proxied");
}
