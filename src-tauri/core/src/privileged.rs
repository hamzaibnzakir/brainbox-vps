//! Running commands that may need root, without ever silently escalating.
//!
//! - root users run commands directly
//! - otherwise `sudo -n` (passwordless sudo) is tried
//! - if sudo needs a password, a `SudoPasswordRequired` error is returned so
//!   the UI can ask; the password is then piped to `sudo -S` and optionally
//!   cached in memory for the rest of the session (never written to disk).

use crate::error::{AppError, ErrorCode, Result};
use crate::model::ExecOutput;
use crate::security::SecretString;
use crate::ssh::exec::{exec, ExecOptions};
use crate::ssh::quote::sh_quote;
use crate::ssh::ServerConnection;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Escalation {
    /// Run as the SSH user only.
    Never,
    /// Try as the SSH user; escalate only on a permission error.
    IfNeeded,
    /// Always run as root.
    Always,
}

/// Session-only sudo passwords, keyed by server id.
#[derive(Default)]
pub struct SudoCache {
    inner: Mutex<HashMap<String, SecretString>>,
}

impl SudoCache {
    pub fn get(&self, server_id: &str) -> Option<SecretString> {
        self.inner.lock().get(server_id).cloned()
    }
    pub fn set(&self, server_id: &str, pw: SecretString) {
        self.inner.lock().insert(server_id.to_string(), pw);
    }
    pub fn clear(&self, server_id: &str) {
        self.inner.lock().remove(server_id);
    }
}

pub async fn is_root(conn: &ServerConnection) -> bool {
    if let Some(v) = conn.probe_get("uid") {
        return v == "0";
    }
    let uid = exec(conn, "id -u", ExecOptions::timeout(10)).await.map(|o| o.stdout.trim().to_string()).unwrap_or_default();
    conn.probe_set("uid", uid.clone());
    uid == "0"
}

fn is_permission_error(o: &ExecOutput) -> bool {
    if o.exit_code == Some(0) {
        return false;
    }
    let e = format!("{}\n{}", o.stderr, o.stdout).to_lowercase();
    e.contains("permission denied")
        || e.contains("operation not permitted")
        || e.contains("access denied")
        || e.contains("interactive authentication required")
        || e.contains("must be root")
        || e.contains("are you root")
        || e.contains("authentication is required")
        || e.contains("got permission denied while trying to connect to the docker daemon")
}

fn sudo_error(o: &ExecOutput) -> Option<AppError> {
    let e = o.stderr.to_lowercase();
    if e.contains("a password is required") || e.contains("a terminal is required") || e.contains("no askpass") {
        return Some(AppError::new(ErrorCode::SudoPasswordRequired, "Administrator password needed", "This action needs sudo. Enter your sudo password to continue."));
    }
    if e.contains("incorrect password") || e.contains("sorry, try again") {
        return Some(AppError::new(ErrorCode::SudoPasswordRequired, "Wrong sudo password", "The sudo password was not accepted. Try again."));
    }
    if e.contains("not in the sudoers") || e.contains("is not allowed to run sudo") || e.contains("may not run sudo") {
        return Some(AppError::new(ErrorCode::PermissionDenied, "Not allowed to use sudo", "Your SSH user is not allowed to run commands as root on this server.")
            .causes(["Ask an administrator to add you to the sudo group", "Log in as a user with sudo rights"])
            .details(o.stderr.trim().to_string()));
    }
    if e.contains("sudo: command not found") || e.contains("sudo: not found") {
        return Some(AppError::new(ErrorCode::PermissionDenied, "sudo is not installed", "This action needs root, but sudo is not available on the server.")
            .causes(["Log in as root to perform this action"]));
    }
    None
}

/// Wrap a shell snippet so it runs as root via sudo.
pub fn sudo_wrap(cmd: &str, with_password: bool) -> String {
    if with_password {
        format!("sudo -S -p '' -- sh -c {}", sh_quote(cmd))
    } else {
        format!("sudo -n -- sh -c {}", sh_quote(cmd))
    }
}

pub async fn run_as_root(conn: &ServerConnection, cache: &Arc<SudoCache>, cmd: &str, password: Option<SecretString>, opts: ExecOptions) -> Result<ExecOutput> {
    if is_root(conn).await {
        return exec(conn, cmd, opts).await;
    }
    let pw = password.clone().or_else(|| cache.get(&conn.server_id));
    let out = match &pw {
        Some(p) => {
            let mut o = opts.clone();
            o.stdin = Some(format!("{}\n", p.expose()).into_bytes());
            exec(conn, &sudo_wrap(cmd, true), o).await?
        }
        None => exec(conn, &sudo_wrap(cmd, false), opts).await?,
    };
    if out.exit_code != Some(0) {
        if let Some(e) = sudo_error(&out) {
            if pw.is_some() && e.code == ErrorCode::SudoPasswordRequired {
                cache.clear(&conn.server_id);
            }
            return Err(e);
        }
    } else if let Some(p) = password {
        cache.set(&conn.server_id, p);
    }
    Ok(out)
}

/// Run `cmd` with the requested escalation policy.
pub async fn run(conn: &ServerConnection, cache: &Arc<SudoCache>, cmd: &str, esc: Escalation, password: Option<SecretString>, opts: ExecOptions) -> Result<ExecOutput> {
    match esc {
        Escalation::Never => exec(conn, cmd, opts).await,
        Escalation::Always => run_as_root(conn, cache, cmd, password, opts).await,
        Escalation::IfNeeded => {
            let out = exec(conn, cmd, opts.clone()).await?;
            if is_permission_error(&out) && !is_root(conn).await {
                run_as_root(conn, cache, cmd, password, opts).await
            } else {
                Ok(out)
            }
        }
    }
}

/// Like [`run`] but requires exit code 0.
pub async fn run_ok(conn: &ServerConnection, cache: &Arc<SudoCache>, cmd: &str, what: &str, esc: Escalation, password: Option<SecretString>, opts: ExecOptions) -> Result<ExecOutput> {
    let out = run(conn, cache, cmd, esc, password, opts).await?;
    if out.exit_code == Some(0) {
        Ok(out)
    } else {
        let msg = if out.stderr.trim().is_empty() { out.stdout.clone() } else { out.stderr.clone() };
        Err(AppError::command_failed(what, out.exit_code, &msg))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn o(code: u32, err: &str) -> ExecOutput {
        ExecOutput { stdout: String::new(), stderr: err.into(), exit_code: Some(code), duration_ms: 0, truncated: false }
    }
    #[test]
    fn classify_sudo_errors() {
        assert_eq!(sudo_error(&o(1, "sudo: a password is required")).unwrap().code, ErrorCode::SudoPasswordRequired);
        assert_eq!(sudo_error(&o(1, "bob is not in the sudoers file.")).unwrap().code, ErrorCode::PermissionDenied);
        assert!(sudo_error(&o(1, "nginx: config error")).is_none());
        assert!(is_permission_error(&o(1, "Failed to start nginx.service: Interactive authentication required.")));
        assert!(!is_permission_error(&o(0, "permission denied")));
    }
    #[test]
    fn wrapping_quotes_command() {
        assert_eq!(sudo_wrap("systemctl restart 'my svc'", false), "sudo -n -- sh -c 'systemctl restart '\\''my svc'\\'''");
    }
}
