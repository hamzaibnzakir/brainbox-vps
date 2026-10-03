//! Command risk classification.
//!
//! Separates read-only inspection from mutating and destructive commands.
//! The classifier is deliberately conservative: anything it does not
//! positively recognise as read-only is treated as *mutating*.

use crate::model::{CommandAssessment, CommandRisk};
use once_cell::sync::Lazy;
use regex::Regex;

/// Split a shell command line into simple-command segments on `;`, `&&`, `||`,
/// `|`, `&` and newlines, respecting single/double quotes.
pub fn split_segments(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = cmd.chars().peekable();
    let (mut sq, mut dq, mut esc) = (false, false, false);
    while let Some(c) = chars.next() {
        if esc {
            cur.push(c);
            esc = false;
            continue;
        }
        match c {
            '\\' if !sq => {
                cur.push(c);
                esc = true;
            }
            '\'' if !dq => {
                sq = !sq;
                cur.push(c);
            }
            '"' if !sq => {
                dq = !dq;
                cur.push(c);
            }
            '&' if !sq && !dq && (cur.ends_with('>') || cur.ends_with('<') || chars.peek() == Some(&'>')) => {
                // Redirection such as `2>&1` or `&>file`, not a separator.
                cur.push(c);
            }
            ';' | '\n' | '|' | '&' if !sq && !dq => {
                // consume doubled operators (&&, ||)
                if (c == '|' || c == '&') && chars.peek() == Some(&c) {
                    chars.next();
                }
                if !cur.trim().is_empty() {
                    out.push(cur.trim().to_string());
                }
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// Tokenise one simple command (very small shell-words implementation).
pub fn tokenize(seg: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let (mut sq, mut dq) = (false, false);
    let mut chars = seg.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' if !dq => {
                sq = !sq;
                has = true;
            }
            '"' if !sq => {
                dq = !dq;
                has = true;
            }
            '\\' if !sq => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    has = true;
                }
            }
            c if c.is_whitespace() && !sq && !dq => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            _ => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

static DANGEROUS_PATTERNS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    let p = |r: &str| Regex::new(r).expect("valid regex");
    vec![
        (p(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}"), "fork bomb"),
        (p(r"(?i)\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b"), "pipes a downloaded script into a shell"),
        (p(r">\s*/dev/(sd|nvme|vd|xvd|hd)[a-z0-9]*"), "writes directly to a disk device"),
        (p(r"(?i)\bdrop\s+(database|table|schema)\b"), "drops a database object"),
        (p(r"(?i)\btruncate\s+table\b"), "truncates a database table"),
    ]
});

const READ_ONLY_PROGRAMS: &[&str] = &[
    "ls", "ll", "la", "cat", "tac", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "zgrep", "zcat",
    "stat", "df", "du", "free", "uptime", "ps", "pgrep", "pstree", "whoami", "id", "groups", "hostname", "uname",
    "date", "pwd", "echo", "printf", "which", "whereis", "type", "env", "printenv", "lsof", "ss", "netstat", "wc",
    "sort", "uniq", "cut", "tr", "jq", "yq", "nproc", "lscpu", "lsmod", "lsblk", "blkid", "lspci", "lsusb", "vmstat",
    "iostat", "mpstat", "sar", "w", "who", "last", "lastlog", "getent", "dig", "nslookup", "host", "file", "md5sum",
    "sha1sum", "sha256sum", "sha512sum", "readlink", "realpath", "basename", "dirname", "tree", "test", "[", "true",
    "false", "dmesg", "column", "diff", "cmp", "nl", "fold", "strings", "hexdump", "xxd", "od", "base64", "ldd",
    "top", "htop", "btop", "free", "arch", "locale", "tty", "sleep", "seq", "expr", "bc", "cal", "watch", "ulimit",
    "awk", "gawk", "mawk", "sed", "find", "mount", "findmnt", "ip", "ifconfig", "route", "arp", "ping", "traceroute",
    "tracepath", "mtr", "curl", "ufw", "iptables", "ip6tables", "nft", "crontab", "systemctl", "journalctl",
    "service", "docker", "docker-compose", "podman", "git", "tmux", "screen", "pm2", "npm", "pnpm", "yarn", "pip",
    "pip3", "apt", "apt-cache", "dpkg", "rpm", "yum", "dnf", "apk", "snap", "nginx", "apache2ctl", "apachectl",
    "httpd", "php", "node", "python", "python3", "ruby", "go", "java", "rustc", "cargo", "timedatectl",
    "hostnamectl", "loginctl", "kubectl", "sestatus", "getenforce", "lsattr", "getfacl", "openssl", "certbot",
    "zfs", "zpool", "smartctl", "sensors", "nvidia-smi", "lastb", "faillog", "chage", "showmount", "exportfs",
    "nmcli", "resolvectl", "aa-status", "fail2ban-client", "mysql", "psql", "redis-cli", "mongo", "mongosh",
];

const DANGEROUS_PROGRAMS: &[&str] = &[
    "mkfs", "mke2fs", "mkswap", "fdisk", "sfdisk", "gdisk", "parted", "wipefs", "shred", "dd", "shutdown", "reboot",
    "halt", "poweroff", "userdel", "deluser", "groupdel", "init", "telinit", "pvremove", "vgremove", "lvremove",
];

fn base_name(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn has(args: &[String], flags: &[&str]) -> bool {
    args.iter().any(|a| flags.contains(&a.as_str()))
}

/// True if any short-flag cluster (e.g. `-rf`) contains `ch`, or a long flag equals `long`.
fn has_flag(args: &[String], ch: char, long: &str) -> bool {
    args.iter().any(|a| {
        (a.starts_with('-') && !a.starts_with("--") && a[1..].contains(ch)) || (!long.is_empty() && a == long)
    })
}

fn first_positional(args: &[String]) -> Option<&str> {
    args.iter().find(|a| !a.starts_with('-')).map(|s| s.as_str())
}

/// Strip wrappers such as `sudo`, `env A=B`, `nice`, `timeout 10`, `time`.
fn unwrap_program(tokens: &[String]) -> (Vec<String>, bool) {
    let mut i = 0;
    let mut sudo = false;
    while i < tokens.len() {
        let t = tokens[i].as_str();
        // Leading `NAME=value` environment assignments.
        if !t.starts_with('-') && t.split_once('=').is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')) {
            i += 1;
            continue;
        }
        match base_name(t) {
            "sudo" | "doas" => {
                sudo = true;
                i += 1;
                // skip sudo options like -u user, -E, -n, -S
                while i < tokens.len() && tokens[i].starts_with('-') {
                    let opt = tokens[i].clone();
                    i += 1;
                    if (opt == "-u" || opt == "-g") && i < tokens.len() {
                        i += 1;
                    }
                }
            }
            "env" | "nice" | "nohup" | "time" | "command" | "builtin" | "exec" | "stdbuf" | "ionice" => {
                i += 1;
                while i < tokens.len() && (tokens[i].starts_with('-') || tokens[i].contains('=')) {
                    i += 1;
                }
            }
            "timeout" => {
                i += 1;
                while i < tokens.len() && tokens[i].starts_with('-') {
                    i += 1;
                }
                i += 1; // duration
            }
            _ => break,
        }
    }
    (tokens[i.min(tokens.len())..].to_vec(), sudo)
}

fn classify_segment(seg: &str, reasons: &mut Vec<String>) -> CommandRisk {
    use CommandRisk::*;
    let tokens = tokenize(seg);
    if tokens.is_empty() {
        return ReadOnly;
    }
    // Output redirection to a file (not /dev/null, not fd dup) is a write.
    let redirect_write = tokens.iter().enumerate().any(|(i, t)| {
        let is_redir = t.starts_with('>') || t.starts_with("1>") || t.starts_with("2>") || t.starts_with("&>");
        if !is_redir {
            return t.contains(">/") && !t.contains("/dev/null") && !t.starts_with('-') && !t.contains("=>");
        }
        if t.contains("&1") || t.contains("&2") {
            return false;
        }
        let target = t.trim_start_matches(['1', '2', '&', '>']).to_string();
        let target = if target.is_empty() { tokens.get(i + 1).cloned().unwrap_or_default() } else { target };
        target != "/dev/null"
    });

    let (cmd, sudo) = unwrap_program(&tokens);
    if cmd.is_empty() {
        return ReadOnly;
    }
    let prog = base_name(&cmd[0]).to_string();
    let args = &cmd[1..];
    if sudo {
        reasons.push("runs with sudo (root privileges)".into());
    }

    // ── Dangerous programs ──
    if DANGEROUS_PROGRAMS.iter().any(|d| prog == *d || prog.starts_with(&format!("{d}."))) {
        reasons.push(format!("`{prog}` can cause irreversible damage or downtime"));
        return Dangerous;
    }

    let risk = match prog.as_str() {
        "rm" | "rmdir" | "unlink" => {
            let recursive = has_flag(args, 'r', "--recursive") || has_flag(args, 'R', "");
            let force = has_flag(args, 'f', "--force");
            let critical = args.iter().any(|a| {
                matches!(a.as_str(), "/" | "/*" | "~" | "~/" | "*" | "." | ".." | "/etc" | "/usr" | "/var" | "/home" | "/root" | "/boot" | "/bin" | "/lib")
                    || a == "--no-preserve-root"
            });
            if critical || (recursive && force) {
                reasons.push("recursively deletes files".into());
                Dangerous
            } else {
                reasons.push("deletes files".into());
                Dangerous
            }
        }
        "kill" | "pkill" | "killall" => {
            if args.iter().any(|a| a == "1" || a == "-1") {
                reasons.push("signals init / every process".into());
                Dangerous
            } else if has(args, &["-l", "-L", "--list"]) {
                ReadOnly
            } else {
                reasons.push("terminates processes".into());
                Mutating
            }
        }
        "chmod" | "chown" | "chgrp" => {
            if has_flag(args, 'R', "--recursive") && args.iter().any(|a| a == "/" || a == "/*") {
                reasons.push("recursively changes ownership/permissions of the root filesystem".into());
                Dangerous
            } else {
                reasons.push("changes file permissions".into());
                Mutating
            }
        }
        "truncate" => {
            reasons.push("truncates files".into());
            Dangerous
        }
        "crontab" => {
            if has(args, &["-r"]) {
                reasons.push("removes the crontab".into());
                Dangerous
            } else if has(args, &["-l"]) {
                ReadOnly
            } else {
                Mutating
            }
        }
        "systemctl" => {
            let sub = first_positional(args).unwrap_or("");
            match sub {
                "status" | "show" | "list-units" | "list-unit-files" | "list-timers" | "list-sockets" | "is-active"
                | "is-enabled" | "is-failed" | "cat" | "list-dependencies" | "get-default" | "" => ReadOnly,
                "poweroff" | "reboot" | "halt" | "kexec" | "rescue" | "emergency" => {
                    reasons.push("powers off or reboots the server".into());
                    Dangerous
                }
                "stop" | "disable" | "mask" | "kill"
                    if args.iter().any(|a| a.starts_with("ssh") || a.starts_with("sshd") || a.contains("network")) =>
                {
                    reasons.push("may lock you out of the server (stops SSH/networking)".into());
                    Dangerous
                }
                _ => {
                    reasons.push(format!("changes service state (systemctl {sub})"));
                    Mutating
                }
            }
        }
        "service" => {
            if args.iter().any(|a| a == "status") || args.iter().any(|a| a == "--status-all") {
                ReadOnly
            } else {
                reasons.push("changes service state".into());
                Mutating
            }
        }
        "journalctl" => {
            if args.iter().any(|a| a.starts_with("--vacuum") || a == "--rotate" || a == "--flush") {
                reasons.push("modifies the system journal".into());
                Mutating
            } else {
                ReadOnly
            }
        }
        "docker" | "podman" | "docker-compose" => classify_docker(&prog, args, reasons),
        "git" => classify_git(args, reasons),
        "find" => {
            if has(args, &["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]) {
                reasons.push("find with -delete/-exec can modify files".into());
                Mutating
            } else {
                ReadOnly
            }
        }
        "sed" => {
            if args.iter().any(|a| a.starts_with("-i") || a == "--in-place" || a.starts_with("--in-place=")) {
                reasons.push("edits files in place".into());
                Mutating
            } else {
                ReadOnly
            }
        }
        "awk" | "gawk" | "mawk" => {
            if seg.contains("system(") || seg.contains("| \"") || args.iter().any(|a| a == "-i" || a == "inplace") {
                reasons.push("awk program may execute commands or write files".into());
                Mutating
            } else {
                ReadOnly
            }
        }
        "ip" => {
            let verbs = ["add", "del", "delete", "set", "flush", "change", "replace", "append"];
            if args.iter().any(|a| verbs.contains(&a.as_str())) {
                if args.iter().any(|a| a == "flush") {
                    reasons.push("flushes network configuration".into());
                    Dangerous
                } else {
                    reasons.push("changes network configuration".into());
                    Mutating
                }
            } else {
                ReadOnly
            }
        }
        "ifconfig" | "route" | "arp" => {
            if args.len() > 1 {
                reasons.push("changes network configuration".into());
                Mutating
            } else {
                ReadOnly
            }
        }
        "iptables" | "ip6tables" | "nft" => {
            if has(args, &["-F", "--flush", "flush"]) {
                reasons.push("flushes firewall rules".into());
                Dangerous
            } else if has(args, &["-L", "--list", "-S", "--list-rules", "list"]) {
                ReadOnly
            } else {
                reasons.push("changes firewall rules".into());
                Mutating
            }
        }
        "ufw" => match first_positional(args).unwrap_or("") {
            "status" | "show" | "app" => ReadOnly,
            "disable" | "reset" => {
                reasons.push("disables or resets the firewall".into());
                Dangerous
            }
            _ => {
                reasons.push("changes firewall rules".into());
                Mutating
            }
        },
        "curl" => {
            let writes = has(args, &["-o", "-O", "--output", "--remote-name", "-T", "--upload-file", "-d", "--data", "--data-binary", "--data-raw", "-F", "--form"])
                || args.windows(2).any(|w| (w[0] == "-X" || w[0] == "--request") && !w[1].eq_ignore_ascii_case("GET") && !w[1].eq_ignore_ascii_case("HEAD"));
            if writes {
                reasons.push("curl writes files or sends data".into());
                Mutating
            } else {
                ReadOnly
            }
        }
        "mount" | "findmnt" => {
            if prog == "mount" && args.iter().any(|a| !a.starts_with('-')) {
                reasons.push("mounts a filesystem".into());
                Mutating
            } else {
                ReadOnly
            }
        }
        "tmux" | "screen" => {
            if has(args, &["ls", "list-sessions", "-ls", "-list"]) {
                ReadOnly
            } else {
                Mutating
            }
        }
        "pm2" => match first_positional(args).unwrap_or("") {
            "list" | "ls" | "status" | "l" | "jlist" | "prettylist" | "show" | "describe" | "info" | "logs" | "monit" => ReadOnly,
            "delete" | "kill" => {
                reasons.push("removes PM2 processes".into());
                Dangerous
            }
            _ => {
                reasons.push("changes PM2 processes".into());
                Mutating
            }
        },
        "npm" | "pnpm" | "yarn" => match first_positional(args).unwrap_or("") {
            "ls" | "list" | "view" | "info" | "outdated" | "why" | "explain" | "config" | "root" | "bin" | "-v" | "" => {
                if args.iter().any(|a| a == "set" || a == "delete") {
                    Mutating
                } else {
                    ReadOnly
                }
            }
            _ => {
                reasons.push("runs package manager actions/scripts".into());
                Mutating
            }
        },
        "pip" | "pip3" => match first_positional(args).unwrap_or("") {
            "list" | "show" | "freeze" | "check" | "" => ReadOnly,
            _ => {
                reasons.push("installs or removes Python packages".into());
                Mutating
            }
        },
        "apt" | "apt-get" | "yum" | "dnf" | "apk" | "snap" | "zypper" | "pacman" => match first_positional(args).unwrap_or("") {
            "list" | "search" | "show" | "info" | "policy" | "history" | "" => ReadOnly,
            "remove" | "purge" | "autoremove" | "erase" | "del" => {
                reasons.push("removes system packages".into());
                Dangerous
            }
            _ => {
                reasons.push("installs or changes system packages".into());
                Mutating
            }
        },
        "apt-cache" => ReadOnly,
        "dpkg" => {
            if has(args, &["-l", "-L", "-s", "-S", "--list", "--status", "--search", "--listfiles", "--get-selections"]) {
                ReadOnly
            } else if has(args, &["-r", "-P", "--remove", "--purge"]) {
                reasons.push("removes system packages".into());
                Dangerous
            } else {
                reasons.push("changes installed packages".into());
                Mutating
            }
        }
        "rpm" => {
            if args.iter().any(|a| a.starts_with("-q")) {
                ReadOnly
            } else if has_flag(args, 'e', "--erase") {
                reasons.push("removes system packages".into());
                Dangerous
            } else {
                Mutating
            }
        }
        "nginx" | "apache2ctl" | "apachectl" | "httpd" => {
            if has(args, &["-t", "-T", "-V", "-v", "configtest", "-S", "-M"]) {
                ReadOnly
            } else {
                reasons.push("controls the web server".into());
                Mutating
            }
        }
        "php" | "node" | "python" | "python3" | "ruby" | "java" | "go" | "rustc" | "cargo" => {
            if has(args, &["-v", "--version", "-V", "version"]) {
                ReadOnly
            } else {
                reasons.push(format!("runs a {prog} program"));
                Mutating
            }
        }
        "kubectl" => match first_positional(args).unwrap_or("") {
            "get" | "describe" | "logs" | "top" | "version" | "explain" | "api-resources" | "cluster-info" => ReadOnly,
            "delete" | "drain" => {
                reasons.push("deletes Kubernetes resources".into());
                Dangerous
            }
            _ => {
                reasons.push("changes Kubernetes resources".into());
                Mutating
            }
        },
        "mysql" | "psql" | "redis-cli" | "mongo" | "mongosh" => {
            let low = seg.to_ascii_lowercase();
            if low.contains("flushall") || low.contains("flushdb") || low.contains("drop ") || low.contains("delete from") {
                reasons.push("deletes database data".into());
                Dangerous
            } else if ["select ", "show ", "describe ", "\\l", "\\dt", "info", "keys ", "get ", "ping", "explain "]
                .iter()
                .any(|k| low.contains(k))
            {
                ReadOnly
            } else {
                reasons.push("database client may change data".into());
                Mutating
            }
        }
        "openssl" => {
            if has(args, &["-out", "genrsa", "req", "genpkey"]) {
                Mutating
            } else {
                ReadOnly
            }
        }
        "certbot" => {
            if has(args, &["certificates"]) {
                ReadOnly
            } else {
                reasons.push("issues or renews certificates".into());
                Mutating
            }
        }
        "timedatectl" | "hostnamectl" | "loginctl" | "resolvectl" | "nmcli" => {
            match first_positional(args).unwrap_or("") {
                "" | "status" | "show" | "list" | "list-sessions" | "list-users" | "show-session" | "query" | "statistics" | "device" | "connection" | "general" => ReadOnly,
                _ => {
                    reasons.push("changes system configuration".into());
                    Mutating
                }
            }
        }
        "fail2ban-client" => {
            if has(args, &["status", "ping", "version", "get"]) {
                ReadOnly
            } else {
                Mutating
            }
        }
        "zfs" | "zpool" => match first_positional(args).unwrap_or("") {
            "list" | "status" | "get" | "iostat" | "history" => ReadOnly,
            "destroy" => {
                reasons.push("destroys storage pools or datasets".into());
                Dangerous
            }
            _ => Mutating,
        },
        "watch" => ReadOnly,
        p if READ_ONLY_PROGRAMS.contains(&p) => ReadOnly,
        p => {
            reasons.push(format!("`{p}` is not a known read-only command"));
            Mutating
        }
    };

    if redirect_write {
        reasons.push("redirects output into a file".into());
        return risk.max(Mutating);
    }
    risk
}

fn classify_docker(prog: &str, args: &[String], reasons: &mut Vec<String>) -> CommandRisk {
    use CommandRisk::*;
    let positional: Vec<&str> = args.iter().filter(|a| !a.starts_with('-')).map(|s| s.as_str()).collect();
    let (sub, sub2) = if prog == "docker-compose" {
        ("compose", positional.first().copied().unwrap_or(""))
    } else {
        (positional.first().copied().unwrap_or(""), positional.get(1).copied().unwrap_or(""))
    };
    let read_sub = [
        "ps", "images", "inspect", "logs", "stats", "version", "info", "top", "port", "diff", "history", "events", "search",
    ];
    match sub {
        s if read_sub.contains(&s) => ReadOnly,
        "container" | "image" | "volume" | "network" | "system" | "context" | "node" | "service" | "stack" => match sub2 {
            "ls" | "list" | "inspect" | "df" | "info" | "logs" | "ps" | "show" | "top" | "port" | "history" => ReadOnly,
            "prune" | "rm" | "remove" => {
                reasons.push(format!("deletes Docker {sub}s"));
                Dangerous
            }
            _ => {
                reasons.push(format!("changes Docker {sub}s"));
                Mutating
            }
        },
        "compose" => match sub2 {
            "ps" | "logs" | "config" | "ls" | "top" | "images" | "version" | "port" => ReadOnly,
            "down" | "rm" => {
                if args.iter().any(|a| a == "-v" || a == "--volumes") {
                    reasons.push("removes containers and their volumes".into());
                    Dangerous
                } else {
                    reasons.push("stops and removes compose services".into());
                    Mutating
                }
            }
            _ => {
                reasons.push("changes compose services".into());
                Mutating
            }
        },
        "rm" | "rmi" => {
            reasons.push("removes Docker containers or images".into());
            Dangerous
        }
        "kill" => {
            reasons.push("kills containers".into());
            Mutating
        }
        _ => {
            reasons.push(format!("changes Docker state (docker {sub})"));
            Mutating
        }
    }
}

fn classify_git(args: &[String], reasons: &mut Vec<String>) -> CommandRisk {
    use CommandRisk::*;
    // skip global options like -C <path>, -c k=v
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        if args[i] == "-C" || args[i] == "-c" {
            i += 1;
        }
        i += 1;
    }
    let sub = args.get(i).map(|s| s.as_str()).unwrap_or("");
    let rest = &args[(i + 1).min(args.len())..];
    match sub {
        "status" | "log" | "diff" | "show" | "rev-parse" | "describe" | "ls-files" | "ls-remote" | "blame" | "shortlog"
        | "reflog" | "grep" | "cat-file" | "rev-list" | "whatchanged" | "count-objects" | "version" | "" => ReadOnly,
        "branch" => {
            if has(rest, &["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "-f", "--force"]) {
                reasons.push("modifies branches".into());
                Mutating
            } else if rest.iter().any(|a| !a.starts_with('-')) {
                reasons.push("creates a branch".into());
                Mutating
            } else {
                ReadOnly
            }
        }
        "remote" => {
            if rest.is_empty() || has(rest, &["-v", "show", "get-url"]) {
                ReadOnly
            } else {
                Mutating
            }
        }
        "tag" => {
            if rest.is_empty() || has(rest, &["-l", "--list"]) {
                ReadOnly
            } else {
                Mutating
            }
        }
        "config" => {
            if has(rest, &["--get", "--list", "-l", "--get-all"]) {
                ReadOnly
            } else {
                Mutating
            }
        }
        "stash" => {
            if rest.first().map(|s| s.as_str()) == Some("list") || rest.first().map(|s| s.as_str()) == Some("show") {
                ReadOnly
            } else if has(rest, &["drop", "clear"]) {
                reasons.push("discards stashed changes".into());
                Dangerous
            } else {
                Mutating
            }
        }
        "reset" if has(rest, &["--hard"]) => {
            reasons.push("discards local changes (git reset --hard)".into());
            Dangerous
        }
        "clean" if rest.iter().any(|a| a.starts_with('-') && a.contains('f')) => {
            reasons.push("deletes untracked files (git clean -f)".into());
            Dangerous
        }
        "push" if has(rest, &["-f", "--force", "--force-with-lease", "--delete", "--mirror"]) => {
            reasons.push("force-pushes or deletes remote history".into());
            Dangerous
        }
        "checkout" if has(rest, &["-f", "--force", "."]) => {
            reasons.push("discards local changes".into());
            Dangerous
        }
        _ => {
            reasons.push(format!("changes the repository (git {sub})"));
            Mutating
        }
    }
}

/// Classify a full command line.
pub fn assess(cmd: &str) -> CommandAssessment {
    let mut reasons = Vec::new();
    let mut risk = CommandRisk::ReadOnly;
    for (re, why) in DANGEROUS_PATTERNS.iter() {
        if re.is_match(cmd) {
            reasons.push((*why).to_string());
            risk = CommandRisk::Dangerous;
        }
    }
    if cmd.contains("$(") || cmd.contains('`') || cmd.contains("<(") {
        reasons.push("contains command substitution that cannot be fully analysed".into());
        risk = risk.max(CommandRisk::Mutating);
    }
    for seg in split_segments(cmd) {
        // Recurse into `sh -c '…'` / `bash -c "…"`.
        let toks = tokenize(&seg);
        let (inner, _) = unwrap_program(&toks);
        if inner.len() >= 3 && matches!(base_name(&inner[0]), "sh" | "bash" | "zsh" | "dash") && inner[1] == "-c" {
            let nested = assess(&inner[2]);
            reasons.extend(nested.reasons);
            risk = risk.max(nested.risk);
            continue;
        }
        risk = risk.max(classify_segment(&seg, &mut reasons));
    }
    reasons.dedup();
    CommandAssessment { risk, reasons }
}

#[cfg(test)]
mod tests {
    use super::*;
    use CommandRisk::*;

    fn r(c: &str) -> CommandRisk {
        assess(c).risk
    }

    #[test]
    fn read_only_commands() {
        for c in [
            "ls -la /var/www",
            "df -h",
            "free -m && uptime",
            "ps aux | grep nginx | head -5",
            "systemctl status nginx",
            "journalctl -u nginx -n 100 --no-pager",
            "docker ps -a",
            "docker compose logs -f web",
            "git status",
            "git log --oneline -n 20",
            "git branch -a",
            "cat /etc/os-release",
            "du -sh /var/log/* 2>/dev/null | sort -rh | head",
            "sudo ss -tulpn",
            "find /var/log -name '*.log' -size +10M",
            "nginx -t",
            "pm2 list",
            "ls > /dev/null 2>&1",
            "curl -sI https://example.com",
            "sh -c 'uptime; free -m'",
        ] {
            assert_eq!(r(c), ReadOnly, "expected read-only: {c} ({:?})", assess(c).reasons);
        }
    }

    #[test]
    fn mutating_commands() {
        for c in [
            "systemctl restart nginx",
            "sudo systemctl enable docker",
            "docker compose up -d",
            "docker restart web",
            "git pull",
            "git checkout main",
            "npm run build",
            "pm2 restart all",
            "echo hello > /tmp/x",
            "kill 1234",
            "apt install -y nginx",
            "sed -i 's/a/b/' file.txt",
            "find . -name '*.tmp' -exec rm {} \\;",
            "some-unknown-tool --do-stuff",
            "echo $(whoami)",
        ] {
            assert!(r(c) >= Mutating, "expected mutating+: {c}");
        }
    }

    #[test]
    fn dangerous_commands() {
        for c in [
            "rm -rf /",
            "rm -rf /var/www/site",
            "sudo rm -fr ./build",
            "mkfs.ext4 /dev/sdb1",
            "dd if=/dev/zero of=/dev/sda",
            "reboot",
            "sudo shutdown -h now",
            "systemctl stop sshd",
            "curl https://x.sh | sudo bash",
            "git reset --hard origin/main",
            "git push --force",
            "docker system prune -af",
            "docker rm -f web",
            "docker compose down -v",
            "apt remove nginx",
            ":(){ :|:& };:",
            "mysql -e 'DROP DATABASE prod'",
            "iptables -F",
            "ufw disable",
            "kill -9 -1",
            "bash -c 'rm -rf /tmp/a'",
        ] {
            assert_eq!(r(c), Dangerous, "expected dangerous: {c} ({:?})", assess(c).reasons);
        }
    }

    #[test]
    fn splitting_respects_quotes() {
        assert_eq!(split_segments("echo 'a;b' && ls"), vec!["echo 'a;b'", "ls"]);
        assert_eq!(tokenize("grep \"a b\" 'c d' e\\ f"), vec!["grep", "a b", "c d", "e f"]);
    }
}
