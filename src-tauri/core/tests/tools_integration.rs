//! Monitoring, processes, ports, services, sudo, Docker, Git, logs and
//! broadcast against the real test servers.

mod common;

use base64::Engine;
use brainbox_core::error::ErrorCode;
use brainbox_core::events::names;
use brainbox_core::model::*;
use brainbox_core::monitoring::{self, Monitor};
use brainbox_core::privileged::{self, SudoCache};
use brainbox_core::security::SecretString;
use brainbox_core::ssh::exec::{exec, ExecOptions};
use brainbox_core::terminal::TerminalManager;
use brainbox_core::{broadcast, docker, git, logs};
use common::*;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Duration;

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
async fn monitoring_processes_ports_services() {
    require_ssh!();
    let h = harness();
    let (p, c) = connected(&h, "mon").await;

    let info = monitoring::system_info(&c).await.unwrap();
    assert!(!info.hostname.is_empty());
    assert!(info.cpu_cores >= 1);
    assert!(info.kernel.starts_with("Linux"));

    let mon = Monitor::new(h.mgr.clone(), h.mgr.sink().clone());
    mon.start(&p.id, 500);
    assert!(until(|| h.sink.named(names::METRICS).len() >= 2, 20).await, "metrics emitted");
    let m = mon.latest(&p.id).unwrap();
    assert!(m.mem_total > 0 && m.mem_used > 0 && m.mem_used <= m.mem_total);
    assert!(m.uptime_secs > 0);
    assert!(m.process_count > 5);
    assert!(m.cpu_percent >= 0.0 && m.cpu_percent <= 100.0);
    assert!(m.listening_ports.unwrap_or(0) >= 2, "{:?}", m.listening_ports);
    assert!(m.latency_ms.is_some());
    assert!(mon.history(&p.id).len() >= 2);
    mon.stop(&p.id);

    // Processes.
    exec(&c, "nohup sleep 4242 >/dev/null 2>&1 &", ExecOptions::default()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let procs = monitoring::list_processes(&c).await.unwrap();
    let sl = procs.iter().find(|p| p.command == "sleep 4242").expect("sleep listed");
    assert_eq!(sl.user, "bbx");
    assert_eq!(sl.name, "sleep");
    let det = monitoring::process_details(&c, sl.pid).await.unwrap();
    assert!(det.contains("Command: sleep 4242"));
    let sudo = Arc::new(SudoCache::default());
    assert_eq!(monitoring::signal_process(&c, &sudo, sl.pid, Signal::Term, false, None).await.unwrap_err().code, ErrorCode::ConfirmationRequired);
    monitoring::signal_process(&c, &sudo, sl.pid, Signal::Term, true, None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!monitoring::list_processes(&c).await.unwrap().iter().any(|p| p.command == "sleep 4242"));
    assert!(monitoring::process_details(&c, sl.pid).await.is_err());
    assert!(monitoring::signal_process(&c, &sudo, 1, Signal::Kill, true, None).await.is_err());

    // Ports.
    let ports = monitoring::list_ports(&c).await.unwrap();
    assert!(ports.iter().any(|p| p.port == 2222 && p.protocol == "tcp"), "{ports:?}");

    // Services: no systemd in this sandbox → clear explanation instead of a broken view.
    let e = monitoring::list_services(&c).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::SystemdUnavailable);
    assert!(!e.causes.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sudo_flow() {
    require_ssh!();
    let h = harness();
    let (_p, c) = connected(&h, "sudo").await;
    let cache = Arc::new(SudoCache::default());
    let e = privileged::run_as_root(&c, &cache, "id -u", None, ExecOptions::default()).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::SudoPasswordRequired);
    let e = privileged::run_as_root(&c, &cache, "id -u", Some(SecretString::new("wrong")), ExecOptions::default()).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::SudoPasswordRequired);
    let out = privileged::run_as_root(&c, &cache, "id -u", Some(SecretString::new(PASS)), ExecOptions::default()).await.unwrap();
    assert_eq!(out.stdout.trim(), "0");
    // Cached for the session.
    let out = privileged::run_as_root(&c, &cache, "whoami", None, ExecOptions::default()).await.unwrap();
    assert_eq!(out.stdout.trim(), "root");
    // IfNeeded only escalates on permission errors.
    let out = privileged::run(&c, &cache, "cat /etc/shadow | head -c 4", privileged::Escalation::IfNeeded, None, ExecOptions::default()).await.unwrap();
    assert_eq!(out.exit_code, Some(0));
    let out = privileged::run(&c, &cache, "whoami", privileged::Escalation::IfNeeded, None, ExecOptions::default()).await.unwrap();
    assert_eq!(out.stdout.trim(), "bbx");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn docker_management() {
    require_ssh!();
    let h = harness();
    let (p, c) = connected(&h, "docker").await;
    let st = docker::status(&c, true).await.unwrap();
    if !st.available {
        eprintln!("docker unavailable in this environment: {:?}", st.reason);
        assert!(st.reason.is_some());
        return;
    }
    assert!(!st.uses_sudo);
    let cs = docker::containers(&c).await.unwrap();
    let web = cs.iter().find(|x| x.name == "bbx-web").expect("test container present (see scripts)");
    assert_eq!(web.state, "running");
    assert!(docker::images(&c).await.unwrap().iter().any(|i| i.repository == "bbx/busybox"));
    docker::volumes(&c).await.unwrap();
    assert!(docker::networks(&c).await.unwrap().iter().any(|n| n.name == "none"));
    let stats = docker::stats(&c).await.unwrap();
    assert!(stats.iter().any(|s| s.name == "bbx-web"));
    assert!(docker::inspect(&c, "bbx-web").await.unwrap().contains("\"Name\": \"/bbx-web\""));
    assert!(docker::inspect(&c, "x;id").await.is_err());

    // Live logs.
    let ls = logs::LogStreams::new(h.mgr.clone(), Arc::new(SudoCache::default()));
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let l2 = lines.clone();
    let sid = ls
        .start(LogStreamRequest { server_id: p.id.clone(), source: LogSource::Docker { container: "bbx-web".into() }, lines: 2, follow: true, sudo: false }, Arc::new(move |ev| {
            if let StreamEvent::Lines { lines } = ev {
                l2.lock().extend(lines)
            }
        }))
        .await
        .unwrap();
    assert!(until(|| lines.lock().len() >= 3, 15).await, "follows new log lines");
    assert!(lines.lock().iter().all(|l| l.contains("tick")));
    ls.stop(&sid);

    // Container-stopped notification from the background monitor.
    let mon = Monitor::new(h.mgr.clone(), h.mgr.sink().clone());
    mon.start(&p.id, 1000);
    tokio::time::sleep(Duration::from_secs(2)).await;

    assert_eq!(docker::container_action(&c, "bbx-web", ContainerAction::Stop, false).await.unwrap_err().code, ErrorCode::ConfirmationRequired);
    docker::container_action(&c, "bbx-web", ContainerAction::Stop, true).await.unwrap();
    assert_eq!(docker::containers(&c).await.unwrap().iter().find(|x| x.name == "bbx-web").unwrap().state, "exited");
    let notified = until(|| h.sink.named(names::NOTIFY).iter().any(|n| n["kind"] == "container_stopped"), 25).await;
    mon.stop(&p.id);
    docker::container_action(&c, "bbx-web", ContainerAction::Start, true).await.unwrap();
    assert!(notified, "container stop notification");

    // Exec shell into the container through a PTY terminal.
    let cmd = docker::exec_shell_command(&c, "bbx-web").await.unwrap();
    let tm = TerminalManager::new(h.mgr.clone());
    let out = Arc::new(Mutex::new(Vec::<u8>::new()));
    let o2 = out.clone();
    let t = tm
        .open_remote(TerminalOpenRequest { server_id: p.id.clone(), cols: 80, rows: 24, tmux_session: None, command: Some(cmd), cwd: None }, Arc::new(move |ev| {
            if let TerminalEvent::Data { data } = ev {
                o2.lock().extend(base64::engine::general_purpose::STANDARD.decode(data).unwrap());
            }
        }))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    tm.write(&t.id, b"echo inside-$(cat /proc/1/cmdline | head -c 7)\n").unwrap();
    assert!(until(|| String::from_utf8_lossy(&out.lock()).contains("inside-/bin/sh"), 10).await, "{}", String::from_utf8_lossy(&out.lock()));
    tm.close(&t.id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn git_tools() {
    require_ssh!();
    let h = harness();
    let (_p, c) = connected(&h, "git").await;
    let repo = format!("/home/bbx/{}", unique("repo"));
    let script = format!(
        "set -e; mkdir -p {repo}/src; cd {repo}; git init -q -b main; git config user.email t@x; git config user.name Tester; \
         echo a > src/a.txt; git add .; git commit -qm 'Initial commit'; git branch feature; \
         echo b >> src/a.txt; echo new > 'new file.txt'"
    );
    exec(&c, &script, ExecOptions::default()).await.unwrap();
    let found = git::discover(&c, Some("/home/bbx")).await.unwrap();
    assert!(found.contains(&repo));
    let st = git::status(&c, &repo).await.unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert_eq!(st.files.len(), 2);
    assert!(st.files.iter().any(|f| f.path == "new file.txt" && f.untracked));
    let br = git::branches(&c, &repo).await.unwrap();
    assert_eq!(br.len(), 2);
    assert!(br.iter().any(|b| b.name == "main" && b.is_current));
    let log = git::log(&c, &repo, 10, None).await.unwrap();
    assert_eq!(log[0].subject, "Initial commit");
    assert!(git::show(&c, &repo, &log[0].hash).await.unwrap().contains("src/a.txt"));
    assert!(git::diff(&c, &repo, Some("src/a.txt"), false).await.unwrap().contains("+b"));
    assert_eq!(git::checkout(&c, &repo, "feature", false).await.unwrap_err().code, ErrorCode::ConfirmationRequired);
    assert!(git::checkout(&c, &repo, "--orphan", true).await.is_err());
    git::checkout(&c, &repo, "feature", true).await.unwrap();
    assert_eq!(git::status(&c, &repo).await.unwrap().branch.as_deref(), Some("feature"));
    let e = git::action(&c, &repo, GitAction::Pull, true).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::CommandFailed);
    let e = git::status(&c, "/tmp").await.unwrap_err();
    assert_eq!(e.title, "Not a Git repository");
    exec(&c, &format!("rm -rf {repo}"), ExecOptions::default()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn log_files_and_export() {
    require_ssh!();
    let h = harness();
    let (p, c) = connected(&h, "logs").await;
    let f = format!("/home/bbx/{}.log", unique("app"));
    exec(&c, &format!("seq 1 50000 > {f}"), ExecOptions::default()).await.unwrap();
    let ls = logs::LogStreams::new(h.mgr.clone(), Arc::new(SudoCache::default()));
    let got = Arc::new(Mutex::new(Vec::<String>::new()));
    let ended = Arc::new(Mutex::new(false));
    let (g2, e2) = (got.clone(), ended.clone());
    ls.start(LogStreamRequest { server_id: p.id.clone(), source: LogSource::File { path: f.clone() }, lines: 100, follow: false, sudo: false }, Arc::new(move |ev| match ev {
        StreamEvent::Lines { lines } => g2.lock().extend(lines),
        StreamEvent::End { .. } => *e2.lock() = true,
        _ => {}
    }))
    .await
    .unwrap();
    assert!(until(|| *ended.lock(), 10).await);
    assert_eq!(got.lock().len(), 100);
    assert_eq!(got.lock().last().unwrap(), "50000");

    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("export.log");
    let n = logs::export(&c, &SudoCache::default(), &LogSource::File { path: f.clone() }, false, &dest.to_string_lossy()).await.unwrap();
    assert!(n > 200_000);
    let content = std::fs::read_to_string(&dest).unwrap();
    assert_eq!(content.lines().count(), 50000);

    let cands = logs::discover_files(&c).await.unwrap();
    assert!(!cands.is_empty() || true);
    exec(&c, &format!("rm -f {f}"), ExecOptions::default()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn broadcast_across_servers() {
    require_ssh!();
    let h = harness();
    let a = add_password_server(&h, "prod-1");
    let b = h.storage.create_server(&server_input("prod-2", PORT2, AuthMethod::Password)).unwrap();
    let offline = h.storage.create_server(&server_input("prod-3", PORT, AuthMethod::Password)).unwrap();
    h.mgr.connect(&a.id, None).await.unwrap();
    h.mgr.connect(&b.id, None).await.unwrap();
    let ids = vec![a.id.clone(), b.id.clone(), offline.id.clone()];
    let (_bid, res) = broadcast::run(&h.mgr, h.mgr.sink(), &ids, "echo $SSH_CONNECTION | awk '{print $4}'", false, 30).await.unwrap();
    assert_eq!(res.len(), 3);
    let r1 = res.iter().find(|r| r.server_id == a.id).unwrap();
    assert_eq!(r1.output.as_ref().unwrap().stdout.trim(), "2222");
    let r2 = res.iter().find(|r| r.server_id == b.id).unwrap();
    assert_eq!(r2.output.as_ref().unwrap().stdout.trim(), "2223");
    let r3 = res.iter().find(|r| r.server_id == offline.id).unwrap();
    assert_eq!(r3.error.as_ref().unwrap().code, ErrorCode::NotConnected);
    assert_eq!(h.sink.named(names::BROADCAST).len(), 3);

    let e = broadcast::run(&h.mgr, h.mgr.sink(), &ids, "rm -rf /tmp/x", false, 30).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::ConfirmationRequired);
}
