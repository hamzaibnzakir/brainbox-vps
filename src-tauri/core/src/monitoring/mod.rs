//! Server monitoring, processes, ports and systemd services.

pub mod parse;

use crate::error::{AppError, ErrorCode, Result};
use crate::events::{names, EventSinkExt, SharedSink};
use crate::model::*;
use crate::privileged::{self, Escalation, SudoCache};
use crate::security::SecretString;
use crate::ssh::exec::{exec, ExecOptions};
use crate::ssh::manager::ConnEvent;
use crate::ssh::quote::{sh_quote, sh_script};
use crate::ssh::{ConnectionManager, ServerConnection};
use parking_lot::Mutex;
use parse::CpuTimes;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::sync::watch;

const SAMPLE_SCRIPT: &str = r#"
echo @@stat; head -n1 /proc/stat
echo @@mem; cat /proc/meminfo
echo @@load; cat /proc/loadavg
echo @@uptime; cat /proc/uptime
echo @@net; cat /proc/net/dev
echo @@disk; df -PkT 2>/dev/null
echo @@procs; ls -d /proc/[0-9]* 2>/dev/null | wc -l
echo @@cpus; grep -c ^processor /proc/cpuinfo
echo @@ports; { ss -Htuln 2>/dev/null || netstat -tuln 2>/dev/null | tail -n +3; } | grep -cE 'LISTEN|UNCONN|^udp'
"#;

const HISTORY: usize = 600;

pub async fn system_info(conn: &ServerConnection) -> Result<SystemInfo> {
    let script = r#"
echo @@host; hostname
echo @@uname; uname -sr; uname -m
echo @@os; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -o
echo @@cpu; grep -m1 'model name' /proc/cpuinfo | cut -d: -f2-
echo @@cores; grep -c ^processor /proc/cpuinfo
"#;
    let out = exec(conn, &sh_script(script), ExecOptions::timeout(20)).await?;
    let s = parse::sections(&out.stdout);
    let get = |k: &str| s.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
    let uname = get("uname");
    let mut ul = uname.lines();
    Ok(SystemInfo {
        hostname: get("host"),
        kernel: ul.next().unwrap_or("").to_string(),
        arch: ul.next().unwrap_or("").to_string(),
        os: get("os"),
        cpu_model: get("cpu"),
        cpu_cores: get("cores").parse().unwrap_or(1),
    })
}

#[derive(Default, Clone, Copy)]
struct Prev {
    cpu: Option<CpuTimes>,
    net: Option<(u64, u64, Instant)>,
}

async fn sample(conn: &ServerConnection, prev: &mut Prev) -> Result<MetricsSnapshot> {
    let t0 = Instant::now();
    let out = exec(conn, &sh_script(SAMPLE_SCRIPT), ExecOptions::timeout(20)).await?;
    let latency = t0.elapsed().as_millis() as u32;
    if out.exit_code != Some(0) && out.stdout.trim().is_empty() {
        return Err(AppError::new(ErrorCode::Unsupported, "Monitoring unavailable", "This server does not expose Linux /proc statistics.").details(out.stderr));
    }
    let s = parse::sections(&out.stdout);
    let g = |k: &str| s.get(k).map(|x| x.as_str()).unwrap_or("");
    let cpu = parse::cpu_times(g("stat"));
    let cpu_percent = match (prev.cpu, cpu) {
        (Some(a), Some(b)) => parse::cpu_percent(a, b),
        _ => 0.0,
    };
    prev.cpu = cpu.or(prev.cpu);
    let mem = parse::meminfo(g("mem"));
    let (l1, l5, l15) = parse::loadavg(g("load"));
    let (rx, tx) = parse::net_totals(g("net"));
    let now_i = Instant::now();
    let (rx_bps, tx_bps) = match prev.net {
        Some((prx, ptx, pt)) => {
            let dt = (now_i - pt).as_secs_f64().max(0.001);
            (rx.saturating_sub(prx) as f64 / dt, tx.saturating_sub(ptx) as f64 / dt)
        }
        None => (0.0, 0.0),
    };
    prev.net = Some((rx, tx, now_i));
    Ok(MetricsSnapshot {
        server_id: conn.server_id.clone(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        cpu_percent,
        cpu_cores: g("cpus").trim().parse().unwrap_or(1),
        mem_total: mem.total,
        mem_used: mem.used,
        mem_available: mem.available,
        mem_cached: mem.cached,
        swap_total: mem.swap_total,
        swap_used: mem.swap_used,
        load1: l1,
        load5: l5,
        load15: l15,
        uptime_secs: parse::uptime(g("uptime")),
        net_rx_bps: rx_bps,
        net_tx_bps: tx_bps,
        net_rx_total: rx,
        net_tx_total: tx,
        disks: parse::df(g("disk")),
        process_count: g("procs").trim().parse().unwrap_or(0),
        listening_ports: g("ports").trim().parse().ok(),
        latency_ms: Some(latency),
    })
}

struct Poller {
    interval_tx: watch::Sender<Duration>,
    history: Arc<Mutex<VecDeque<MetricsSnapshot>>>,
    stop: tokio_util::sync::CancellationToken,
}

/// Polls each subscribed server at a configurable interval with a single
/// cheap script (reads /proc and df — no expensive commands).
pub struct Monitor {
    conns: Arc<ConnectionManager>,
    sink: SharedSink,
    pollers: Mutex<HashMap<String, Poller>>,
    docker_watch: Mutex<HashMap<String, HashMap<String, String>>>,
}

impl Monitor {
    pub fn new(conns: Arc<ConnectionManager>, sink: SharedSink) -> Arc<Self> {
        let me = Arc::new(Self { conns: conns.clone(), sink, pollers: Mutex::new(HashMap::new()), docker_watch: Mutex::new(HashMap::new()) });
        let weak: Weak<Self> = Arc::downgrade(&me);
        conns.on_event(move |ev| {
            if let (Some(m), ConnEvent::Disconnected { server_id }) = (weak.upgrade(), ev) {
                m.stop(server_id);
            }
        });
        me
    }

    pub fn history(&self, server_id: &str) -> Vec<MetricsSnapshot> {
        self.pollers.lock().get(server_id).map(|p| p.history.lock().iter().cloned().collect()).unwrap_or_default()
    }

    pub fn latest(&self, server_id: &str) -> Option<MetricsSnapshot> {
        self.pollers.lock().get(server_id).and_then(|p| p.history.lock().back().cloned())
    }

    /// Start polling (or change the interval of an existing poller).
    pub fn start(self: &Arc<Self>, server_id: &str, interval_ms: u32) {
        let interval = Duration::from_millis(interval_ms.clamp(500, 300_000) as u64);
        if let Some(p) = self.pollers.lock().get(server_id) {
            p.interval_tx.send_replace(interval);
            return;
        }
        let (itx, irx) = watch::channel(interval);
        let history = Arc::new(Mutex::new(VecDeque::with_capacity(HISTORY)));
        let stop = tokio_util::sync::CancellationToken::new();
        self.pollers.lock().insert(server_id.to_string(), Poller { interval_tx: itx, history: history.clone(), stop: stop.clone() });
        let me = Arc::downgrade(self);
        let id = server_id.to_string();
        crate::rt::spawn(async move {
            let mut prev = Prev::default();
            let mut irx = irx;
            let mut last_docker = Instant::now() - Duration::from_secs(3600);
            let mut first = true;
            loop {
                let Some(m) = me.upgrade() else { return };
                if let Some(conn) = m.conns.get(&id).filter(|c| c.is_connected()) {
                    match sample(&conn, &mut prev).await {
                        Ok(snap) => {
                            // The first CPU/net sample has no delta; take a quick second one.
                            if first {
                                first = false;
                                drop(m);
                                tokio::time::sleep(Duration::from_millis(400)).await;
                                continue;
                            }
                            {
                                let mut h = history.lock();
                                if h.len() >= HISTORY {
                                    h.pop_front();
                                }
                                h.push_back(snap.clone());
                            }
                            m.sink.emit(names::METRICS, &snap);
                        }
                        Err(e) => log::debug!("monitor sample failed for {id}: {}", e.message),
                    }
                    if last_docker.elapsed() >= Duration::from_secs(15) {
                        last_docker = Instant::now();
                        m.watch_docker(&conn).await;
                    }
                } else {
                    prev = Prev::default();
                    first = true;
                }
                drop(m);
                let wait = *irx.borrow_and_update();
                tokio::select! {
                    _ = stop.cancelled() => return,
                    _ = tokio::time::sleep(wait) => {}
                    _ = irx.changed() => {}
                }
            }
        });
    }

    pub fn stop(&self, server_id: &str) {
        if let Some(p) = self.pollers.lock().remove(server_id) {
            p.stop.cancel();
        }
        self.docker_watch.lock().remove(server_id);
    }

    /// Notify when a running container stops (only if docker is usable without prompts).
    async fn watch_docker(&self, conn: &ServerConnection) {
        let prefix = match conn.probe_get("docker_prefix") {
            Some(p) if p != "-" => p,
            Some(_) => return,
            None => return, // only once the Docker panel has detected docker
        };
        let Ok(out) = exec(conn, &format!("{prefix}docker ps -a --format '{{{{.ID}}}}\\t{{{{.Names}}}}\\t{{{{.State}}}}'"), ExecOptions::timeout(15)).await else { return };
        if out.exit_code != Some(0) {
            return;
        }
        let cur: HashMap<String, (String, String)> = out
            .stdout
            .lines()
            .filter_map(|l| {
                let v: Vec<&str> = l.split('\t').collect();
                (v.len() == 3).then(|| (v[0].to_string(), (v[1].to_string(), v[2].to_string())))
            })
            .collect();
        let mut watch = self.docker_watch.lock();
        let prev = watch.entry(conn.server_id.clone()).or_default();
        for (id, (name, state)) in &cur {
            if prev.get(id).map(|s| s == "running").unwrap_or(false) && state != "running" && state != "restarting" {
                self.sink.emit(
                    names::NOTIFY,
                    &AppNotification {
                        kind: "container_stopped".into(),
                        title: format!("Container {name} stopped"),
                        body: format!("On {} — state is now {state}.", conn.profile().name),
                        server_id: Some(conn.server_id.clone()),
                    },
                );
            }
        }
        *prev = cur.into_iter().map(|(k, (_, s))| (k, s)).collect();
    }
}

// ───────────────────────────── Processes ─────────────────────────────

pub async fn list_processes(conn: &ServerConnection) -> Result<Vec<ProcessInfo>> {
    let script = "ps -eo pid=,ppid=,user:32=,stat=,pcpu=,pmem=,rss=,etimes=,args= --sort=-pcpu 2>/dev/null | head -n 2000; echo @@comm; ps -eo pid=,comm= 2>/dev/null";
    let out = exec(conn, &sh_script(&format!("echo @@main; {script}")), ExecOptions::timeout(30)).await?;
    let s = parse::sections(&out.stdout);
    let list = parse::processes(s.get("main").map(|x| x.as_str()).unwrap_or(""), s.get("comm").map(|x| x.as_str()).unwrap_or(""));
    if list.is_empty() {
        return Err(AppError::new(ErrorCode::Unsupported, "Process list unavailable", "Could not read the process list (procps `ps` is required).").details(out.stderr));
    }
    Ok(list)
}

pub async fn process_details(conn: &ServerConnection, pid: u32) -> Result<String> {
    let script = format!(
        "p=/proc/{pid}; [ -d $p ] || {{ echo 'Process no longer exists'; exit 1; }}; \
         grep -q '^State:[[:space:]]*Z' $p/status && {{ echo 'zombie'; exit 2; }}; \
         echo \"Command: $(tr '\\0' ' ' < $p/cmdline 2>/dev/null)\"; \
         echo \"Working dir: $(readlink $p/cwd 2>/dev/null || echo '(no permission)')\"; \
         echo \"Executable: $(readlink $p/exe 2>/dev/null || echo '(no permission)')\"; \
         echo \"Open files: $(ls $p/fd 2>/dev/null | wc -l)\"; \
         echo \"Started: $(ps -o lstart= -p {pid})\"; echo; \
         grep -E '^(Name|State|PPid|Uid|Gid|Threads|VmPeak|VmSize|VmRSS|VmSwap|voluntary_ctxt_switches|nonvoluntary_ctxt_switches)' $p/status"
    );
    let out = exec(conn, &sh_script(&script), ExecOptions::timeout(15)).await?;
    if out.exit_code == Some(2) {
        return Err(AppError::new(ErrorCode::NotFound, "Process has exited", format!("Process {pid} has exited and is waiting to be reaped by its parent (zombie).")));
    }
    if out.exit_code != Some(0) {
        return Err(AppError::new(ErrorCode::NotFound, "Process not found", format!("Process {pid} is no longer running.")));
    }
    Ok(out.stdout)
}

pub async fn signal_process(conn: &ServerConnection, sudo: &Arc<SudoCache>, pid: u32, sig: Signal, confirmed: bool, sudo_password: Option<SecretString>) -> Result<()> {
    if !confirmed {
        return Err(AppError::confirmation_required("Stopping a process"));
    }
    if pid <= 1 {
        return Err(AppError::invalid("Refusing to signal PID 0/1 (init)."));
    }
    let s = match sig {
        Signal::Term => "TERM",
        Signal::Kill => "KILL",
        Signal::Hup => "HUP",
        Signal::Int => "INT",
    };
    privileged::run_ok(conn, sudo, &format!("kill -s {s} {pid}"), &format!("Sending SIG{s} to {pid}"), Escalation::IfNeeded, sudo_password, ExecOptions::timeout(20)).await?;
    Ok(())
}

// ───────────────────────────── Ports ─────────────────────────────

pub async fn list_ports(conn: &ServerConnection) -> Result<Vec<PortInfo>> {
    let script = "sudo -n ss -Htulpn 2>/dev/null || ss -Htulpn 2>/dev/null || sudo -n netstat -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null";
    let out = exec(conn, &sh_script(script), ExecOptions::timeout(20)).await?;
    if out.stdout.trim().is_empty() && out.exit_code != Some(0) {
        return Err(AppError::new(ErrorCode::Unsupported, "Port list unavailable", "Neither `ss` nor `netstat` is available on this server.")
            .causes(["Install iproute2 (ss) or net-tools (netstat)"]));
    }
    Ok(parse::ports(&out.stdout))
}

// ───────────────────────────── Services ─────────────────────────────

pub async fn has_systemd(conn: &ServerConnection) -> bool {
    if let Some(v) = conn.probe_get("systemd") {
        return v == "1";
    }
    let ok = exec(conn, "test -d /run/systemd/system && command -v systemctl >/dev/null && echo yes", ExecOptions::timeout(10))
        .await
        .map(|o| o.stdout.trim() == "yes")
        .unwrap_or(false);
    conn.probe_set("systemd", if ok { "1".into() } else { "0".into() });
    ok
}

fn no_systemd() -> AppError {
    AppError::new(ErrorCode::SystemdUnavailable, "systemd not detected", "This server does not run systemd, so services cannot be managed here.")
        .causes(["The server may use another init system (OpenRC, SysV, runit)", "It may be a container without an init system", "You can still manage services from the terminal"])
}

pub fn valid_unit(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 256 || !name.chars().all(|c| c.is_ascii_alphanumeric() || "@._-:\\".contains(c)) {
        return Err(AppError::invalid("Invalid service name."));
    }
    Ok(())
}

pub async fn list_services(conn: &ServerConnection) -> Result<Vec<ServiceInfo>> {
    if !has_systemd(conn).await {
        return Err(no_systemd());
    }
    let script = "echo @@units; systemctl list-units --type=service --all --no-legend --no-pager --plain; echo @@files; systemctl list-unit-files --type=service --no-legend --no-pager";
    let out = exec(conn, &sh_script(script), ExecOptions::timeout(30)).await?;
    let s = parse::sections(&out.stdout);
    Ok(parse::services(s.get("units").map(|x| x.as_str()).unwrap_or(""), s.get("files").map(|x| x.as_str()).unwrap_or("")))
}

pub async fn service_status(conn: &ServerConnection, unit: &str) -> Result<String> {
    valid_unit(unit)?;
    let out = exec(conn, &sh_script(&format!("systemctl status --no-pager -n 30 {} 2>&1", sh_quote(unit))), ExecOptions::timeout(20)).await?;
    Ok(out.stdout)
}

pub async fn service_action(conn: &ServerConnection, sudo: &Arc<SudoCache>, unit: &str, action: ServiceAction, confirmed: bool, sudo_password: Option<SecretString>) -> Result<()> {
    valid_unit(unit)?;
    if !confirmed {
        return Err(AppError::confirmation_required("Changing a service"));
    }
    if !has_systemd(conn).await {
        return Err(no_systemd());
    }
    let verb = match action {
        ServiceAction::Start => "start",
        ServiceAction::Stop => "stop",
        ServiceAction::Restart => "restart",
        ServiceAction::Reload => "reload",
        ServiceAction::Enable => "enable",
        ServiceAction::Disable => "disable",
    };
    let cmd = format!("systemctl {verb} {}", sh_quote(unit));
    privileged::run_ok(conn, sudo, &cmd, &format!("systemctl {verb} {unit}"), Escalation::Always, sudo_password, ExecOptions::timeout(120)).await?;
    Ok(())
}
