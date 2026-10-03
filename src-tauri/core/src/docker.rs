//! Docker management via the docker CLI on the server.

use crate::error::{AppError, ErrorCode, Result};
use crate::model::*;
use crate::ssh::exec::{exec, ExecOptions};
use crate::ssh::quote::sh_quote;
use crate::ssh::ServerConnection;
use serde_json::Value;

/// Detect docker and whether it must be run through `sudo -n`.
/// The result is cached per connection as `docker_prefix` ("" | "sudo -n " | "-").
pub async fn status(conn: &ServerConnection, refresh: bool) -> Result<DockerStatus> {
    if !refresh {
        if let Some(p) = conn.probe_get("docker_prefix") {
            if p != "-" {
                let v = conn.probe_get("docker_version");
                return Ok(DockerStatus { available: true, version: v, uses_sudo: p.starts_with("sudo"), reason: None });
            }
        }
    }
    let probe = exec(conn, "docker version --format '{{.Server.Version}}' 2>&1; echo \"@@rc=$?\"", ExecOptions::timeout(20)).await?;
    let (text, rc) = split_rc(&probe.stdout);
    if rc == 0 {
        conn.probe_set("docker_prefix", String::new());
        conn.probe_set("docker_version", text.trim().to_string());
        return Ok(DockerStatus { available: true, version: Some(text.trim().into()), uses_sudo: false, reason: None });
    }
    let low = text.to_lowercase();
    if low.contains("not found") && !low.contains("daemon") {
        conn.probe_set("docker_prefix", "-".into());
        return Ok(DockerStatus {
            available: false,
            version: None,
            uses_sudo: false,
            reason: Some(AppError::new(ErrorCode::DockerUnavailable, "Docker is not installed", "The `docker` command was not found on this server.")
                .causes(["Install Docker Engine (https://docs.docker.com/engine/install/)", "If Docker is installed elsewhere, make sure it is on the PATH for non-interactive shells"])),
        });
    }
    if low.contains("permission denied") {
        let s = exec(conn, "sudo -n docker version --format '{{.Server.Version}}' 2>&1; echo \"@@rc=$?\"", ExecOptions::timeout(20)).await?;
        let (t2, rc2) = split_rc(&s.stdout);
        if rc2 == 0 {
            conn.probe_set("docker_prefix", "sudo -n ".into());
            conn.probe_set("docker_version", t2.trim().to_string());
            return Ok(DockerStatus { available: true, version: Some(t2.trim().into()), uses_sudo: true, reason: None });
        }
        conn.probe_set("docker_prefix", "-".into());
        return Ok(DockerStatus {
            available: false,
            version: None,
            uses_sudo: false,
            reason: Some(AppError::new(ErrorCode::DockerPermission, "No permission to use Docker", "Your SSH user cannot access the Docker daemon.")
                .causes(["Add the user to the docker group: sudo usermod -aG docker $USER (then reconnect)", "Or configure passwordless sudo for docker"])
                .details(text.trim().to_string())),
        });
    }
    conn.probe_set("docker_prefix", "-".into());
    let reason = if low.contains("cannot connect to the docker daemon") || low.contains("daemon running") || low.contains("daemon is running") || low.contains("failed to connect to the docker api") {
        AppError::new(ErrorCode::DockerUnavailable, "Docker daemon is not running", "Docker is installed but its daemon is not running.")
            .causes(["Start it with: sudo systemctl start docker"])
    } else {
        AppError::new(ErrorCode::DockerUnavailable, "Docker unavailable", "Docker did not respond.")
    };
    Ok(DockerStatus { available: false, version: None, uses_sudo: false, reason: Some(reason.details(text.trim().to_string())) })
}

fn split_rc(s: &str) -> (String, i32) {
    match s.rfind("@@rc=") {
        Some(i) => (s[..i].to_string(), s[i + 5..].trim().parse().unwrap_or(1)),
        None => (s.to_string(), 1),
    }
}

async fn prefix(conn: &ServerConnection) -> Result<String> {
    let st = status(conn, false).await?;
    if !st.available {
        return Err(st.reason.unwrap_or_else(|| AppError::new(ErrorCode::DockerUnavailable, "Docker unavailable", "Docker is not available.")));
    }
    Ok(conn.probe_get("docker_prefix").unwrap_or_default())
}

async fn docker(conn: &ServerConnection, args: &str, what: &str, secs: u64) -> Result<String> {
    let p = prefix(conn).await?;
    let out = exec(conn, &format!("{p}docker {args}"), ExecOptions::timeout(secs)).await?;
    if out.exit_code != Some(0) {
        return Err(AppError::command_failed(what, out.exit_code, if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr }));
    }
    Ok(out.stdout)
}

fn json_lines(s: &str) -> Vec<Value> {
    s.lines().filter_map(|l| serde_json::from_str(l.trim()).ok()).collect()
}

fn st(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub fn parse_containers(s: &str) -> Vec<DockerContainer> {
    json_lines(s)
        .iter()
        .map(|v| {
            let labels = st(v, "Labels");
            let compose = labels.split(',').find_map(|kv| kv.strip_prefix("com.docker.compose.project=")).map(str::to_string);
            DockerContainer {
                id: st(v, "ID"),
                name: st(v, "Names"),
                image: st(v, "Image"),
                state: st(v, "State"),
                status: st(v, "Status"),
                ports: st(v, "Ports"),
                created: st(v, "CreatedAt"),
                compose_project: compose,
            }
        })
        .collect()
}

pub async fn containers(conn: &ServerConnection) -> Result<Vec<DockerContainer>> {
    let out = docker(conn, "ps -a --no-trunc --format '{{json .}}'", "Listing containers", 30).await?;
    let mut c = parse_containers(&out);
    c.sort_by(|a, b| (a.state != "running").cmp(&(b.state != "running")).then_with(|| a.name.cmp(&b.name)));
    Ok(c)
}

pub async fn images(conn: &ServerConnection) -> Result<Vec<DockerImage>> {
    let out = docker(conn, "images --format '{{json .}}'", "Listing images", 30).await?;
    Ok(json_lines(&out)
        .iter()
        .map(|v| DockerImage { id: st(v, "ID"), repository: st(v, "Repository"), tag: st(v, "Tag"), size: st(v, "Size"), created: st(v, "CreatedSince") })
        .collect())
}

pub async fn volumes(conn: &ServerConnection) -> Result<Vec<DockerVolume>> {
    let out = docker(conn, "volume ls --format '{{json .}}'", "Listing volumes", 30).await?;
    Ok(json_lines(&out).iter().map(|v| DockerVolume { name: st(v, "Name"), driver: st(v, "Driver"), mountpoint: st(v, "Mountpoint") }).collect())
}

pub async fn networks(conn: &ServerConnection) -> Result<Vec<DockerNetwork>> {
    let out = docker(conn, "network ls --format '{{json .}}'", "Listing networks", 30).await?;
    Ok(json_lines(&out).iter().map(|v| DockerNetwork { id: st(v, "ID"), name: st(v, "Name"), driver: st(v, "Driver"), scope: st(v, "Scope") }).collect())
}

pub async fn stats(conn: &ServerConnection) -> Result<Vec<DockerStats>> {
    let out = docker(conn, "stats --no-stream --format '{{json .}}'", "Reading container stats", 45).await?;
    Ok(json_lines(&out)
        .iter()
        .map(|v| DockerStats {
            id: st(v, "ID"),
            name: st(v, "Name"),
            cpu_percent: st(v, "CPUPerc"),
            mem_usage: st(v, "MemUsage"),
            mem_percent: st(v, "MemPerc"),
            net_io: st(v, "NetIO"),
            block_io: st(v, "BlockIO"),
            pids: st(v, "PIDs"),
        })
        .collect())
}

pub fn valid_ref(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 256 || !id.chars().all(|c| c.is_ascii_alphanumeric() || "._-:/@".contains(c)) {
        return Err(AppError::invalid("Invalid container/image reference."));
    }
    Ok(())
}

pub async fn inspect(conn: &ServerConnection, id: &str) -> Result<String> {
    valid_ref(id)?;
    let out = docker(conn, &format!("inspect {}", sh_quote(id)), "Inspecting", 30).await?;
    // Pretty-print for display.
    Ok(serde_json::from_str::<Value>(&out).ok().and_then(|v| serde_json::to_string_pretty(&v).ok()).unwrap_or(out))
}

pub async fn container_action(conn: &ServerConnection, id: &str, action: ContainerAction, confirmed: bool) -> Result<()> {
    valid_ref(id)?;
    if !confirmed {
        return Err(AppError::confirmation_required("Changing a container"));
    }
    let args = match action {
        ContainerAction::Start => format!("start {}", sh_quote(id)),
        ContainerAction::Stop => format!("stop {}", sh_quote(id)),
        ContainerAction::Restart => format!("restart {}", sh_quote(id)),
        ContainerAction::Pause => format!("pause {}", sh_quote(id)),
        ContainerAction::Unpause => format!("unpause {}", sh_quote(id)),
        ContainerAction::Remove => format!("rm -f {}", sh_quote(id)),
    };
    docker(conn, &args, &format!("docker {:?}", action).to_lowercase(), 180).await?;
    Ok(())
}

pub async fn remove_image(conn: &ServerConnection, id: &str, confirmed: bool) -> Result<()> {
    valid_ref(id)?;
    if !confirmed {
        return Err(AppError::confirmation_required("Removing an image"));
    }
    docker(conn, &format!("rmi {}", sh_quote(id)), "Removing image", 120).await?;
    Ok(())
}

pub async fn remove_volume(conn: &ServerConnection, name: &str, confirmed: bool) -> Result<()> {
    valid_ref(name)?;
    if !confirmed {
        return Err(AppError::confirmation_required("Removing a volume"));
    }
    docker(conn, &format!("volume rm {}", sh_quote(name)), "Removing volume", 120).await?;
    Ok(())
}

/// Command line for an interactive shell inside a container (run in a PTY terminal).
pub async fn exec_shell_command(conn: &ServerConnection, id: &str) -> Result<String> {
    valid_ref(id)?;
    let p = prefix(conn).await?;
    Ok(format!(
        "{p}docker exec -it {} sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'",
        sh_quote(id)
    ))
}

/// Command line used by the log viewer to follow a container's logs.
pub async fn logs_command(conn: &ServerConnection, id: &str, lines: u32, follow: bool) -> Result<String> {
    valid_ref(id)?;
    let p = prefix(conn).await?;
    Ok(format!("{p}docker logs --tail {lines} --timestamps {} {} 2>&1", if follow { "-f" } else { "" }, sh_quote(id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_ps_json() {
        let s = r#"{"Command":"\"nginx\"","CreatedAt":"2024-01-01 10:00:00 +0000 UTC","ID":"abc123","Image":"nginx:latest","Labels":"com.docker.compose.project=shop,com.docker.compose.service=web","Names":"shop-web-1","Ports":"0.0.0.0:80->80/tcp","State":"running","Status":"Up 2 hours"}
{"ID":"def","Names":"db","Image":"postgres:16","State":"exited","Status":"Exited (0) 3 days ago","Labels":"","Ports":"","CreatedAt":"x"}
not json"#;
        let c = parse_containers(s);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].compose_project.as_deref(), Some("shop"));
        assert_eq!(c[0].ports, "0.0.0.0:80->80/tcp");
        assert_eq!(c[1].state, "exited");
        assert_eq!(split_rc("24.0.7\n@@rc=0\n"), ("24.0.7\n".into(), 0));
    }
    #[test]
    fn refs_validated() {
        assert!(valid_ref("my-app_1").is_ok());
        assert!(valid_ref("ghcr.io/org/img:1.2@sha256:abc").is_ok());
        assert!(valid_ref("x; rm -rf /").is_err());
    }
}
