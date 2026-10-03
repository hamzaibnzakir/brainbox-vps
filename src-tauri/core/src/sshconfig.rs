//! Minimal OpenSSH client config parser for importing hosts.
//!
//! Supports `Host`, `HostName`, `Port`, `User`, `IdentityFile`, `ProxyJump`
//! and `Include`, with OpenSSH's "first obtained value wins" semantics and
//! `*`/`?` wildcard patterns (including `!` negation).

use crate::model::SshConfigHost;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Clone)]
struct Block {
    patterns: Vec<String>,
    params: Vec<(String, String)>,
}

fn glob_match(pat: &str, s: &str) -> bool {
    fn rec(p: &[char], s: &[char]) -> bool {
        match (p.first(), s.first()) {
            (None, None) => true,
            (Some('*'), _) => rec(&p[1..], s) || (!s.is_empty() && rec(p, &s[1..])),
            (Some('?'), Some(_)) => rec(&p[1..], &s[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => rec(&p[1..], &s[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pat.chars().collect();
    let s: Vec<char> = s.chars().collect();
    rec(&p, &s)
}

fn block_matches(b: &Block, alias: &str) -> bool {
    let mut matched = false;
    for p in &b.patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if glob_match(neg, alias) {
                return false;
            }
        } else if glob_match(p, alias) {
            matched = true;
        }
    }
    matched
}

fn split_kv(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (k, v) = match line.find(|c: char| c.is_whitespace() || c == '=') {
        Some(i) => (&line[..i], line[i..].trim_start_matches(|c: char| c.is_whitespace() || c == '=')),
        None => (line, ""),
    };
    let v = v.trim().trim_matches('"').to_string();
    Some((k.to_ascii_lowercase(), v))
}

fn expand_home(p: &str, home: &Path) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else if p == "~" {
        home.to_path_buf()
    } else {
        PathBuf::from(p)
    }
}

fn parse_into(text: &str, base_dir: &Path, home: &Path, blocks: &mut Vec<Block>, depth: u8) {
    let mut cur = Block { patterns: vec!["*".into()], params: vec![] };
    let mut started = false;
    for line in text.lines() {
        let Some((k, v)) = split_kv(line) else { continue };
        match k.as_str() {
            "host" => {
                if started || !cur.params.is_empty() {
                    blocks.push(std::mem::take(&mut cur));
                }
                cur = Block { patterns: v.split_whitespace().map(|s| s.to_string()).collect(), params: vec![] };
                started = true;
            }
            "match" => {
                // `Match` blocks are conditional on runtime state; skip them.
                if started || !cur.params.is_empty() {
                    blocks.push(std::mem::take(&mut cur));
                }
                cur = Block { patterns: vec!["!*".into()], params: vec![] };
                started = true;
            }
            "include" if depth < 8 => {
                for pat in v.split_whitespace() {
                    let p = expand_home(pat, home);
                    let p = if p.is_absolute() { p } else { base_dir.join(p) };
                    for file in expand_glob_path(&p) {
                        if let Ok(t) = std::fs::read_to_string(&file) {
                            // Included params belong to the current block context.
                            let mut inner = Vec::new();
                            parse_into(&t, base_dir, home, &mut inner, depth + 1);
                            for b in inner {
                                if b.patterns == ["*"] && !started {
                                    cur.params.extend(b.params);
                                } else {
                                    blocks.push(b);
                                }
                            }
                        }
                    }
                }
            }
            _ => cur.params.push((k, v)),
        }
    }
    blocks.push(cur);
}

fn expand_glob_path(p: &Path) -> Vec<PathBuf> {
    let s = p.to_string_lossy();
    if !s.contains('*') && !s.contains('?') {
        return vec![p.to_path_buf()];
    }
    let (Some(dir), Some(name)) = (p.parent(), p.file_name()) else { return vec![] };
    let name = name.to_string_lossy().to_string();
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| glob_match(&name, &e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// Parse config text; `base_dir` resolves relative `Include`s, `home` expands `~`.
pub fn parse(text: &str, base_dir: &Path, home: &Path) -> Vec<SshConfigHost> {
    let mut blocks = Vec::new();
    parse_into(text, base_dir, home, &mut blocks, 0);

    let mut aliases: Vec<String> = Vec::new();
    for b in &blocks {
        for p in &b.patterns {
            if !p.contains('*') && !p.contains('?') && !p.starts_with('!') && !aliases.contains(p) {
                aliases.push(p.clone());
            }
        }
    }

    aliases
        .into_iter()
        .map(|alias| {
            let get = |key: &str| -> Option<String> {
                for b in &blocks {
                    if block_matches(b, &alias) {
                        if let Some((_, v)) = b.params.iter().find(|(k, _)| k == key) {
                            return Some(v.clone());
                        }
                    }
                }
                None
            };
            let host = get("hostname").unwrap_or_else(|| alias.clone()).replace("%h", &alias);
            let port = get("port").and_then(|p| p.parse().ok()).unwrap_or(22);
            let username = get("user");
            let identity_file = get("identityfile").map(|p| expand_home(&p, home).to_string_lossy().to_string());
            let proxy_jump = get("proxyjump").filter(|v| !v.eq_ignore_ascii_case("none"));
            SshConfigHost { alias, host, port, username, identity_file, proxy_jump, already_imported: false }
        })
        .collect()
}

/// Read the user's default config (`~/.ssh/config`).
pub fn read_default() -> Vec<SshConfigHost> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let dir = home.join(".ssh");
    match std::fs::read_to_string(dir.join("config")) {
        Ok(t) => parse(&t, &dir, &home),
        Err(_) => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts_with_defaults() {
        let cfg = r#"
# global
Host prod-*
    User deploy
    IdentityFile ~/.ssh/prod_ed25519

Host prod-web prod-db
    HostName %h.example.com
    Port 2222

Host bastion
    HostName 203.0.113.5
    User admin

Host prod-db
    ProxyJump bastion
    Port 9999

Host *
    User fallback
    ServerAliveInterval 30
"#;
        let home = Path::new("/home/u");
        let hosts = parse(cfg, Path::new("/home/u/.ssh"), home);
        let names: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, vec!["prod-web", "prod-db", "bastion"]);

        let web = &hosts[0];
        assert_eq!(web.host, "prod-web.example.com");
        assert_eq!(web.port, 2222);
        assert_eq!(web.username.as_deref(), Some("deploy"));
        assert_eq!(web.identity_file.as_deref(), Some(Path::new("/home/u/.ssh/prod_ed25519").to_string_lossy().as_ref()));

        let db = &hosts[1];
        assert_eq!(db.port, 2222, "first obtained value wins");
        assert_eq!(db.proxy_jump.as_deref(), Some("bastion"));

        let b = &hosts[2];
        assert_eq!(b.username.as_deref(), Some("admin"));
        assert_eq!(b.port, 22);
    }

    #[test]
    fn equals_syntax_and_negation() {
        let cfg = "Host a b\nUser=x\nHost * !b\nPort=2200\n";
        let hosts = parse(cfg, Path::new("/"), Path::new("/h"));
        assert_eq!(hosts[0].port, 2200);
        assert_eq!(hosts[1].port, 22);
        assert_eq!(hosts[1].username.as_deref(), Some("x"));
    }

    #[test]
    fn includes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("conf.d")).unwrap();
        std::fs::write(dir.path().join("conf.d/a.conf"), "Host inc\n  HostName 1.2.3.4\n").unwrap();
        let hosts = parse("Include conf.d/*.conf\nHost main\n HostName m\n", dir.path(), dir.path());
        assert!(hosts.iter().any(|h| h.alias == "inc" && h.host == "1.2.3.4"));
        assert!(hosts.iter().any(|h| h.alias == "main"));
    }
}
