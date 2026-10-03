//! Tools exposed to the model. All are read-only except `propose_command`,
//! which never executes anything by itself.

use super::provider::ToolDef;
use crate::model::{CommandRisk, ExecOutput};
use crate::security::policy::{assess, split_segments, tokenize};
use crate::ssh::exec::{exec, ExecOptions};
use crate::ssh::quote::{sh_quote, sh_script};
use crate::ssh::ServerConnection;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};

pub fn definitions() -> Vec<ToolDef> {
    let t = |name: &str, desc: &str, schema: Value| ToolDef { name: name.into(), description: desc.into(), schema };
    vec![
        t("get_system_overview", "Hostname, OS, uptime, load, CPU count, memory, swap, disk usage and the top CPU/memory processes.", json!({"type":"object","properties":{}})),
        t(
            "list_processes",
            "List running processes sorted by CPU or memory.",
            json!({"type":"object","properties":{"sort_by":{"type":"string","enum":["cpu","memory"]},"limit":{"type":"integer","minimum":1,"maximum":100}}}),
        ),
        t("list_listening_ports", "Show listening TCP/UDP ports and the owning processes.", json!({"type":"object","properties":{}})),
        t(
            "service_status",
            "systemd status and the last log lines of a service (e.g. nginx).",
            json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}),
        ),
        t("list_failed_services", "List failed systemd units.", json!({"type":"object","properties":{}})),
        t("docker_overview", "Docker containers (all states) and their current CPU/memory usage.", json!({"type":"object","properties":{}})),
        t(
            "read_logs",
            "Read recent log lines. source: system | service | docker | file. target: unit name, container name or file path.",
            json!({"type":"object","properties":{"source":{"type":"string","enum":["system","service","docker","file"]},"target":{"type":"string"},"lines":{"type":"integer","minimum":1,"maximum":500},"grep":{"type":"string","description":"optional case-insensitive filter"}},"required":["source"]}),
        ),
        t(
            "disk_usage",
            "Largest directories directly under a path (du, one filesystem).",
            json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        ),
        t("git_status", "Git branch and changed files of a repository.", json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]})),
        t(
            "run_readonly_command",
            "Run a single READ-ONLY inspection command (e.g. `cat /etc/nginx/nginx.conf`, `journalctl -p err -n 50`). Commands that change anything are refused — use propose_command for those.",
            json!({"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}),
        ),
        t(
            "propose_command",
            "Propose ONE shell command that changes the server. It is NOT executed until the user approves it; you will then receive its output.",
            json!({"type":"object","properties":{"command":{"type":"string"},"reason":{"type":"string","description":"why this fixes the problem and any risk"}},"required":["command","reason"]}),
        ),
    ]
}

pub fn describe_input(v: &Value) -> String {
    match v.as_object() {
        Some(m) if m.is_empty() => String::new(),
        Some(m) => m.iter().map(|(k, v)| format!("{k}: {}", v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))).collect::<Vec<_>>().join(", "),
        None => v.to_string(),
    }
}

pub fn format_exec(o: &ExecOutput) -> String {
    let mut s = String::new();
    if !o.stdout.trim().is_empty() {
        s.push_str(o.stdout.trim_end());
    }
    if !o.stderr.trim().is_empty() {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str("[stderr]\n");
        s.push_str(o.stderr.trim_end());
    }
    if s.is_empty() {
        s.push_str("(no output)");
    }
    if let Some(c) = o.exit_code {
        if c != 0 {
            s.push_str(&format!("\n[exit code {c}]"));
        }
    }
    s
}

static SECRET_PATTERNS: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    let r = |p: &str| Regex::new(p).unwrap();
    vec![
        (r(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED PRIVATE KEY]"),
        (r(r#"(?i)\b((?:[A-Z0-9_]*_)?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential)s?[A-Z0-9_]*)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)"#), "$1$2[REDACTED]"),
        (r(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED AWS KEY]"),
        (r(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"), "[REDACTED GITHUB TOKEN]"),
        (r(r"\bsk-[A-Za-z0-9_-]{20,}\b"), "[REDACTED API KEY]"),
        (r(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"), "[REDACTED SLACK TOKEN]"),
        (r(r"(?i)(://[^:/\s]+:)[^@/\s]+@"), "$1[REDACTED]@"),
    ]
});

/// Remove obvious secrets before output leaves this computer.
pub fn redact(s: &str) -> String {
    let mut out = s.to_string();
    for (re, rep) in SECRET_PATTERNS.iter() {
        out = re.replace_all(&out, *rep).into_owned();
    }
    out
}

static SECRET_FILES: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(^|/)(\.env(\.[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)|[^/\s]*\.(pem|key|p12|pfx|kdbx)|shadow|gshadow|\.netrc|\.pgpass|\.git-credentials|credentials(\.json)?|secrets?\.(ya?ml|json)|\.htpasswd|wp-config\.php|authorized_keys)$").unwrap()
});

/// True if a command reads a file that very likely contains secrets.
pub fn touches_secret_file(cmd: &str) -> bool {
    split_segments(cmd).iter().any(|seg| tokenize(seg).iter().skip(1).any(|t| !t.starts_with('-') && SECRET_FILES.is_match(t.trim_end_matches('/'))))
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

async fn run(conn: &ServerConnection, script: &str, secs: u64) -> (String, bool) {
    match exec(conn, &sh_script(script), ExecOptions::timeout(secs)).await {
        Ok(o) => (format_exec(&o), o.exit_code == Some(0)),
        Err(e) => (format!("Error: {} — {}", e.title, e.message), false),
    }
}

fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() < 200 && n.chars().all(|c| c.is_ascii_alphanumeric() || "@._-:/".contains(c))
}

pub async fn execute(conn: &ServerConnection, name: &str, input: &Value) -> (String, bool) {
    match name {
        "get_system_overview" => {
            if conn.probe_get("ai_os").is_none() {
                if let Ok(o) = exec(conn, &sh_script("(. /etc/os-release && echo \"$PRETTY_NAME\") 2>/dev/null"), ExecOptions::timeout(10)).await {
                    conn.probe_set("ai_os", o.stdout.trim().to_string());
                }
            }
            run(
                conn,
                "echo \"host: $(hostname)\"; (. /etc/os-release 2>/dev/null && echo \"os: $PRETTY_NAME\"); echo \"kernel: $(uname -sr)\"; \
                 echo \"cpus: $(nproc)\"; echo \"uptime/load: $(uptime)\"; echo; free -h; echo; df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null; \
                 echo; echo 'top cpu:'; ps -eo pid,user,pcpu,pmem,rss,comm --sort=-pcpu | head -n 8; echo; echo 'top memory:'; ps -eo pid,user,pcpu,pmem,rss,comm --sort=-rss | head -n 8",
                30,
            )
            .await
        }
        "list_processes" => {
            let sort = if s(input, "sort_by") == "memory" { "-rss" } else { "-pcpu" };
            let limit = input["limit"].as_u64().unwrap_or(25).clamp(1, 100);
            run(conn, &format!("ps -eo pid,ppid,user,stat,pcpu,pmem,rss,etime,args --sort={sort} | head -n {}", limit + 1), 20).await
        }
        "list_listening_ports" => run(conn, "sudo -n ss -tulpn 2>/dev/null || ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null", 20).await,
        "service_status" => {
            let n = s(input, "name");
            if !valid_name(n) {
                return ("Error: invalid service name".into(), false);
            }
            run(conn, &format!("systemctl status --no-pager -n 40 {} 2>&1", sh_quote(n)), 20).await
        }
        "list_failed_services" => run(conn, "systemctl --failed --no-pager 2>&1 || echo 'systemd not available'", 20).await,
        "docker_overview" => {
            let p = conn.probe_get("docker_prefix").filter(|p| p != "-").unwrap_or_default();
            run(conn, &format!("{p}docker ps -a --format 'table {{{{.Names}}}}\\t{{{{.Image}}}}\\t{{{{.Status}}}}\\t{{{{.Ports}}}}' 2>&1; echo; {p}docker stats --no-stream 2>&1"), 45).await
        }
        "read_logs" => {
            let lines = input["lines"].as_u64().unwrap_or(100).clamp(1, 500);
            let target = s(input, "target");
            let base = match s(input, "source") {
                "service" if valid_name(target) => format!("journalctl -u {} -n {lines} --no-pager -o short-iso 2>&1", sh_quote(target)),
                "docker" if valid_name(target) => {
                    let p = conn.probe_get("docker_prefix").filter(|p| p != "-").unwrap_or_default();
                    format!("{p}docker logs --tail {lines} --timestamps {} 2>&1", sh_quote(target))
                }
                "file" if !target.is_empty() => {
                    if touches_secret_file(&format!("tail {target}")) {
                        return ("Refused: this file is likely to contain secrets and is never sent to the AI.".into(), false);
                    }
                    format!("tail -n {lines} -- {} 2>&1", sh_quote(target))
                }
                "system" | "" => format!("journalctl -n {lines} --no-pager -o short-iso 2>/dev/null || tail -n {lines} /var/log/syslog 2>/dev/null || tail -n {lines} /var/log/messages 2>&1"),
                _ => return ("Error: invalid source/target".into(), false),
            };
            let grep = s(input, "grep");
            let script = if grep.is_empty() { base } else { format!("{{ {base}; }} | grep -i -- {} | tail -n {lines}", sh_quote(grep)) };
            run(conn, &script, 30).await
        }
        "disk_usage" => {
            let p = if s(input, "path").is_empty() { "/" } else { s(input, "path") };
            run(conn, &format!("du -xh --max-depth=1 -- {} 2>/dev/null | sort -rh | head -n 25", sh_quote(p)), 120).await
        }
        "git_status" => {
            let p = s(input, "path");
            run(conn, &format!("GIT_TERMINAL_PROMPT=0 git -C {} status -sb 2>&1 && git -C {} log --oneline -n 5 2>&1", sh_quote(p), sh_quote(p)), 30).await
        }
        "run_readonly_command" => {
            let cmd = s(input, "command").trim();
            if cmd.is_empty() {
                return ("Error: command is required".into(), false);
            }
            let a = assess(cmd);
            if a.risk != CommandRisk::ReadOnly {
                return (
                    format!("Refused: this command is not read-only ({}). Use propose_command if a change is needed.", a.reasons.join("; ")),
                    false,
                );
            }
            if touches_secret_file(cmd) {
                return ("Refused: this command reads a file likely to contain secrets, which is never sent to the AI.".into(), false);
            }
            match exec(conn, cmd, ExecOptions::timeout(60)).await {
                Ok(o) => (format_exec(&o), o.exit_code == Some(0)),
                Err(e) => (format!("Error: {}", e.message), false),
            }
        }
        other => (format!("Error: unknown tool `{other}`"), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction() {
        let s = "DB_PASSWORD=hunter2\napi_key: \"abc123\"\nuser=bob\npostgres://app:s3cr3t@db:5432/x\nAKIAABCDEFGHIJKLMNOP\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        let r = redact(s);
        for leaked in ["hunter2", "abc123", "s3cr3t", "AKIAABCDEFGHIJKLMNOP", "AAAA", "ghp_abc"] {
            assert!(!r.contains(leaked), "leaked {leaked}: {r}");
        }
        assert!(r.contains("user=bob"));
        assert!(r.contains("DB_PASSWORD=[REDACTED]"));
    }

    #[test]
    fn secret_files() {
        assert!(touches_secret_file("cat /var/www/app/.env"));
        assert!(touches_secret_file("head -n 5 ~/.ssh/id_ed25519"));
        assert!(touches_secret_file("cat /etc/shadow"));
        assert!(touches_secret_file("grep x /etc/ssl/private/site.key"));
        assert!(!touches_secret_file("cat /etc/nginx/nginx.conf"));
        assert!(!touches_secret_file("ls -la /var/www"));
        assert!(!touches_secret_file("cat .envrc.example.md"));
    }

    #[test]
    fn definitions_are_valid() {
        let d = definitions();
        assert!(d.iter().any(|t| t.name == "propose_command"));
        for t in d {
            assert_eq!(t.schema["type"], "object");
        }
    }
}
