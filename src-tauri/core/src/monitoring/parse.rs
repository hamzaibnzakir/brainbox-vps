//! Pure parsers for Linux system information (unit-testable on fixtures).

use crate::model::{DiskUsage, PortInfo, ProcessInfo, ServiceInfo};
use std::collections::HashMap;

/// Split `@@name` sections of a combined script output.
pub fn sections(s: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut cur: Option<String> = None;
    let mut buf = String::new();
    for line in s.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            if let Some(c) = cur.take() {
                out.insert(c, std::mem::take(&mut buf));
            }
            cur = Some(name.trim().to_string());
        } else if cur.is_some() {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if let Some(c) = cur {
        out.insert(c, buf);
    }
    out
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CpuTimes {
    pub busy: u64,
    pub total: u64,
}

/// First line of /proc/stat.
pub fn cpu_times(stat: &str) -> Option<CpuTimes> {
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
    if v.len() < 4 {
        return None;
    }
    // user nice system idle iowait irq softirq steal (guest included in user)
    let idle = v[3] + v.get(4).copied().unwrap_or(0);
    let total: u64 = v.iter().take(8).sum();
    Some(CpuTimes { busy: total - idle, total })
}

pub fn cpu_percent(prev: CpuTimes, cur: CpuTimes) -> f64 {
    let dt = cur.total.saturating_sub(prev.total);
    if dt == 0 {
        return 0.0;
    }
    (cur.busy.saturating_sub(prev.busy) as f64 / dt as f64 * 100.0).clamp(0.0, 100.0)
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Mem {
    pub total: u64,
    pub available: u64,
    pub used: u64,
    pub cached: u64,
    pub swap_total: u64,
    pub swap_used: u64,
}

/// /proc/meminfo (values in kB → bytes).
pub fn meminfo(s: &str) -> Mem {
    let mut m: HashMap<&str, u64> = HashMap::new();
    for l in s.lines() {
        if let Some((k, v)) = l.split_once(':') {
            if let Some(n) = v.split_whitespace().next().and_then(|n| n.parse::<u64>().ok()) {
                m.insert(k.trim(), n * 1024);
            }
        }
    }
    let total = *m.get("MemTotal").unwrap_or(&0);
    let free = *m.get("MemFree").unwrap_or(&0);
    let buffers = *m.get("Buffers").unwrap_or(&0);
    let cached = m.get("Cached").unwrap_or(&0) + m.get("SReclaimable").unwrap_or(&0);
    let available = m.get("MemAvailable").copied().unwrap_or(free + buffers + cached);
    let swap_total = *m.get("SwapTotal").unwrap_or(&0);
    let swap_free = *m.get("SwapFree").unwrap_or(&0);
    Mem {
        total,
        available,
        used: total.saturating_sub(available),
        cached: cached + buffers,
        swap_total,
        swap_used: swap_total.saturating_sub(swap_free),
    }
}

pub fn loadavg(s: &str) -> (f64, f64, f64) {
    let v: Vec<f64> = s.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
    (v.first().copied().unwrap_or(0.0), v.get(1).copied().unwrap_or(0.0), v.get(2).copied().unwrap_or(0.0))
}

pub fn uptime(s: &str) -> u64 {
    s.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()).map(|f| f as u64).unwrap_or(0)
}

/// Total rx/tx bytes over physical-ish interfaces in /proc/net/dev.
pub fn net_totals(s: &str) -> (u64, u64) {
    let mut rx = 0;
    let mut tx = 0;
    for l in s.lines().skip(2) {
        let Some((iface, rest)) = l.split_once(':') else { continue };
        let iface = iface.trim();
        if iface == "lo" || iface.starts_with("veth") || iface.starts_with("docker") || iface.starts_with("br-") || iface.starts_with("virbr") {
            continue;
        }
        let v: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if v.len() >= 9 {
            rx += v[0];
            tx += v[8];
        }
    }
    (rx, tx)
}

const REAL_FS: &[&str] = &["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "exfat", "ntfs", "ntfs3", "f2fs", "jfs", "reiserfs", "nfs", "nfs4", "cifs", "smb3", "fuseblk", "fuse.sshfs", "ceph", "glusterfs", "apfs", "hfs"];

/// `df -PkT` output.
pub fn df(s: &str) -> Vec<DiskUsage> {
    let mut out: Vec<DiskUsage> = Vec::new();
    for l in s.lines() {
        let v: Vec<&str> = l.split_whitespace().collect();
        if v.len() < 7 || v[0] == "Filesystem" {
            continue;
        }
        let fs_type = v[1];
        let mount = v[6..].join(" ");
        if !REAL_FS.contains(&fs_type) || mount.starts_with("/snap/") || mount.starts_with("/var/lib/docker") {
            continue;
        }
        let k = |x: &str| x.parse::<u64>().unwrap_or(0) * 1024;
        let d = DiskUsage { filesystem: v[0].into(), fs_type: fs_type.into(), mount, total_bytes: k(v[2]), used_bytes: k(v[3]), avail_bytes: k(v[4]) };
        // Same device mounted twice (bind mounts) → keep the shortest mount path.
        if let Some(existing) = out.iter_mut().find(|e| e.filesystem == d.filesystem && e.total_bytes == d.total_bytes) {
            if d.mount.len() < existing.mount.len() {
                *existing = d;
            }
            continue;
        }
        out.push(d);
    }
    out.sort_by(|a, b| (a.mount != "/").cmp(&(b.mount != "/")).then_with(|| a.mount.cmp(&b.mount)));
    out
}

/// `ps -eo pid=,ppid=,user:32=,stat=,pcpu=,pmem=,rss=,etimes=,args=` then
/// `@@comm` and `ps -eo pid=,comm=`.
pub fn processes(main: &str, comm: &str) -> Vec<ProcessInfo> {
    let names: HashMap<u32, String> = comm
        .lines()
        .filter_map(|l| {
            let l = l.trim_start();
            let (pid, name) = l.split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, name.trim().to_string()))
        })
        .collect();
    let mut out = Vec::new();
    for l in main.lines() {
        let mut it = l.split_whitespace();
        let (Some(pid), Some(ppid), Some(user), Some(stat), Some(cpu), Some(mem), Some(rss), Some(et)) =
            (it.next(), it.next(), it.next(), it.next(), it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else { continue };
        let args: Vec<&str> = it.collect();
        let command = args.join(" ");
        let name = names.get(&pid).cloned().unwrap_or_else(|| {
            args.first().map(|a| a.rsplit('/').next().unwrap_or(a).to_string()).unwrap_or_default()
        });
        out.push(ProcessInfo {
            pid,
            ppid: ppid.parse().unwrap_or(0),
            user: user.to_string(),
            state: stat.to_string(),
            cpu_percent: cpu.parse().unwrap_or(0.0),
            mem_percent: mem.parse().unwrap_or(0.0),
            rss_kb: rss.parse().unwrap_or(0),
            elapsed_secs: et.parse().unwrap_or(0),
            name,
            command,
        });
    }
    out
}

fn split_addr_port(s: &str) -> Option<(String, u16)> {
    let i = s.rfind(':')?;
    let port = s[i + 1..].parse().ok()?;
    let mut addr = s[..i].to_string();
    if let Some(p) = addr.find('%') {
        addr.truncate(p);
    }
    let addr = addr.trim_start_matches('[').trim_end_matches(']').to_string();
    Some((if addr.is_empty() { "*".into() } else { addr }, port))
}

/// `ss -Htulpn` (or `netstat -tulpn` as a fallback).
pub fn ports(s: &str) -> Vec<PortInfo> {
    let mut out: Vec<PortInfo> = Vec::new();
    for l in s.lines() {
        let v: Vec<&str> = l.split_whitespace().collect();
        if v.len() < 5 {
            continue;
        }
        let info = if v[0] == "tcp" || v[0] == "udp" || v[0] == "tcp6" || v[0] == "udp6" {
            if v[1].chars().all(|c| c.is_ascii_digit()) {
                // netstat: Proto Recv-Q Send-Q Local Foreign [State] PID/Program
                let proto = v[0].trim_end_matches('6').to_string();
                let Some((addr, port)) = split_addr_port(v[3]) else { continue };
                let (state, procfield) = if proto == "tcp" { (v.get(5).copied().unwrap_or(""), v.get(6).copied()) } else { ("UNCONN", v.get(5).copied()) };
                if proto == "tcp" && state != "LISTEN" {
                    continue;
                }
                let (pid, process) = match procfield.and_then(|p| p.split_once('/')) {
                    Some((pid, name)) => (pid.parse().ok(), Some(name.to_string())),
                    None => (None, None),
                };
                PortInfo { protocol: proto, local_address: addr, port, state: state.into(), process, pid }
            } else {
                // ss: Netid State Recv-Q Send-Q Local Peer [Process]
                let proto = v[0].to_string();
                let Some((addr, port)) = split_addr_port(v[4]) else { continue };
                if proto == "tcp" && v[1] != "LISTEN" {
                    continue;
                }
                let rest = v[6..].join(" ");
                let (process, pid) = parse_ss_users(&rest);
                PortInfo { protocol: proto, local_address: addr, port, state: v[1].into(), process, pid }
            }
        } else {
            continue;
        };
        if !out.iter().any(|p| p.protocol == info.protocol && p.port == info.port && p.local_address == info.local_address) {
            out.push(info);
        }
    }
    out.sort_by(|a, b| a.port.cmp(&b.port).then_with(|| a.protocol.cmp(&b.protocol)));
    out
}

fn parse_ss_users(s: &str) -> (Option<String>, Option<u32>) {
    // users:(("nginx",pid=1234,fd=6),("nginx",pid=1235,fd=6))
    let Some(start) = s.find("((\"") else { return (None, None) };
    let rest = &s[start + 3..];
    let name = rest.split('"').next().map(str::to_string);
    let pid = rest.split("pid=").nth(1).and_then(|p| p.split([',', ')']).next()).and_then(|p| p.parse().ok());
    (name, pid)
}

/// Combine `systemctl list-units` and `systemctl list-unit-files` output.
pub fn services(units: &str, files: &str) -> Vec<ServiceInfo> {
    let enabled: HashMap<String, String> = files
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.to_string(), it.next()?.to_string()))
        })
        .collect();
    let mut out: Vec<ServiceInfo> = Vec::new();
    for l in units.lines() {
        let l = l.trim_start_matches(['●', '*', ' ']);
        let mut it = l.split_whitespace();
        let (Some(unit), Some(load), Some(active), Some(sub)) = (it.next(), it.next(), it.next(), it.next()) else { continue };
        if !unit.ends_with(".service") {
            continue;
        }
        let description = it.collect::<Vec<_>>().join(" ");
        out.push(ServiceInfo {
            name: unit.to_string(),
            description,
            load_state: load.into(),
            active_state: active.into(),
            sub_state: sub.into(),
            enabled_state: enabled.get(unit).cloned().unwrap_or_else(|| "unknown".into()),
        });
    }
    // Installed but never loaded units.
    for (unit, state) in &enabled {
        if unit.ends_with(".service") && !unit.contains('@') && !out.iter().any(|s| &s.name == unit) {
            out.push(ServiceInfo {
                name: unit.clone(),
                description: String::new(),
                load_state: "not-loaded".into(),
                active_state: "inactive".into(),
                sub_state: "dead".into(),
                enabled_state: state.clone(),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_delta() {
        let a = cpu_times("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3").unwrap();
        let b = cpu_times("cpu  150 0 150 900 0 0 0 0 0 0").unwrap();
        assert_eq!(a, CpuTimes { busy: 200, total: 1000 });
        assert!((cpu_percent(a, b) - 50.0).abs() < 0.01);
    }

    #[test]
    fn mem() {
        let m = meminfo("MemTotal:  2000 kB\nMemFree: 500 kB\nMemAvailable: 1500 kB\nBuffers: 100 kB\nCached: 300 kB\nSReclaimable: 50 kB\nSwapTotal: 1000 kB\nSwapFree: 900 kB\n");
        assert_eq!(m.total, 2000 * 1024);
        assert_eq!(m.used, 500 * 1024);
        assert_eq!(m.swap_used, 100 * 1024);
        assert_eq!(m.cached, 450 * 1024);
    }

    #[test]
    fn net() {
        let s = "Inter-|   Receive  |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\nveth12: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n";
        assert_eq!(net_totals(s), (1000, 2000));
    }

    #[test]
    fn disks() {
        let s = "Filesystem     Type     1024-blocks      Used Available Capacity Mounted on\n/dev/vda1      ext4        50000000  20000000  30000000      40% /\ntmpfs          tmpfs         100000         0    100000       0% /run\n/dev/vdb1      xfs        100 50 50 50% /mnt/my data\n/dev/loop0 squashfs 1 1 0 100% /snap/core/1\n/dev/vda1      ext4        50000000  20000000  30000000      40% /var/lib/docker/overlay2\n";
        let d = df(s);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].mount, "/");
        assert_eq!(d[1].mount, "/mnt/my data");
        assert_eq!(d[0].used_bytes, 20000000 * 1024);
    }

    #[test]
    fn ps_parsing() {
        let main = "    1     0 root     Ss    0.0  0.1 12000 86400 /sbin/init splash\n  812     1 www-data S    12.5  3.2 99000   300 nginx: worker process\n  900     1 bbx      S+    0.0  0.0  4000    10 tmux new -s x\n";
        let comm = "    1 systemd\n  812 nginx\n  900 tmux: server\n";
        let p = processes(main, comm);
        assert_eq!(p.len(), 3);
        assert_eq!(p[1].name, "nginx");
        assert_eq!(p[1].command, "nginx: worker process");
        assert_eq!(p[1].cpu_percent, 12.5);
        assert_eq!(p[2].name, "tmux: server");
        assert_eq!(p[0].elapsed_secs, 86400);
    }

    #[test]
    fn ss_and_netstat() {
        let ss = "tcp   LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:((\"nginx\",pid=812,fd=6),(\"nginx\",pid=813,fd=6))\ntcp   LISTEN 0      128             [::]:22           [::]:*    users:((\"sshd\",pid=600,fd=4))\nudp   UNCONN 0      0      127.0.0.53%lo:53        0.0.0.0:*    \ntcp   ESTAB  0      0      10.0.0.2:22  1.2.3.4:5555\n";
        let p = ports(ss);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].port, 22);
        assert_eq!(p[0].local_address, "::");
        assert_eq!(p[0].process.as_deref(), Some("sshd"));
        assert_eq!(p[1].local_address, "127.0.0.53");
        assert_eq!(p[2].pid, Some(812));

        let ns = "tcp        0      0 0.0.0.0:3306            0.0.0.0:*               LISTEN      1100/mysqld\nudp        0      0 0.0.0.0:68              0.0.0.0:*                           700/dhclient\n";
        let p = ports(ns);
        assert_eq!(p.len(), 2);
        assert_eq!(p[1].process.as_deref(), Some("mysqld"));
        assert_eq!(p[0].protocol, "udp");
    }

    #[test]
    fn systemd_services() {
        let units = "nginx.service          loaded active   running A high performance web server\n● bad.service loaded failed failed Broken thing\ncron.service loaded active running Regular background program processing daemon\nfoo.socket loaded active listening x\n";
        let files = "nginx.service enabled enabled\nbad.service disabled enabled\ncron.service enabled enabled\nredis.service masked enabled\ngetty@.service enabled enabled\n";
        let s = services(units, files);
        assert_eq!(s.len(), 4);
        let bad = s.iter().find(|x| x.name == "bad.service").unwrap();
        assert_eq!(bad.active_state, "failed");
        assert_eq!(bad.enabled_state, "disabled");
        assert_eq!(s.iter().find(|x| x.name == "redis.service").unwrap().enabled_state, "masked");
        assert_eq!(s.iter().find(|x| x.name == "nginx.service").unwrap().description, "A high performance web server");
    }

    #[test]
    fn section_split() {
        let s = sections("@@a\n1\n2\n@@b\n@@c\nx\n");
        assert_eq!(s["a"], "1\n2\n");
        assert_eq!(s["b"], "");
        assert_eq!(s["c"], "x\n");
    }
}
