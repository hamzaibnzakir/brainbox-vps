//! Human-friendly error model.
//!
//! Every error that crosses into the UI is an [`AppError`]: a short title, a
//! plain-language message, a list of likely causes and (optionally) the raw
//! technical details, which the UI hides behind an expandable section.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorCode {
    ConnectionRefused,
    ConnectionTimeout,
    HostNotFound,
    HostUnreachable,
    NetworkDown,
    AuthFailed,
    NeedPassword,
    NeedPassphrase,
    BadPassphrase,
    KeyLoadFailed,
    AgentUnavailable,
    HostKeyUnknown,
    HostKeyMismatch,
    HostKeyRejected,
    ProxyFailed,
    JumpHostFailed,
    Disconnected,
    NotConnected,
    PermissionDenied,
    NotFound,
    AlreadyExists,
    NotADirectory,
    IsADirectory,
    SudoPasswordRequired,
    ConfirmationRequired,
    Unsupported,
    DockerUnavailable,
    DockerPermission,
    SystemdUnavailable,
    GitUnavailable,
    CommandFailed,
    Cancelled,
    InvalidInput,
    Storage,
    Vault,
    Ai,
    Io,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
#[error("{title}: {message}")]
pub struct AppError {
    pub code: ErrorCode,
    pub title: String,
    pub message: String,
    #[serde(default)]
    pub causes: Vec<String>,
    #[serde(default)]
    pub details: Option<String>,
}

pub type Result<T, E = AppError> = std::result::Result<T, E>;

impl AppError {
    pub fn new(code: ErrorCode, title: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code, title: title.into(), message: message.into(), causes: vec![], details: None }
    }
    pub fn causes<I: IntoIterator<Item = S>, S: Into<String>>(mut self, c: I) -> Self {
        self.causes = c.into_iter().map(Into::into).collect();
        self
    }
    pub fn details(mut self, d: impl Into<String>) -> Self {
        let d = d.into();
        self.details = if d.is_empty() { None } else { Some(d) };
        self
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        let m = msg.into();
        Self::new(ErrorCode::Internal, "Something went wrong", "An unexpected internal error occurred.").details(m)
    }
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, "Invalid input", msg)
    }
    pub fn not_connected() -> Self {
        Self::new(ErrorCode::NotConnected, "Not connected", "This server is not connected. Connect to it first.")
    }
    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "Cancelled", "The operation was cancelled.")
    }
    pub fn confirmation_required(what: &str) -> Self {
        Self::new(
            ErrorCode::ConfirmationRequired,
            "Confirmation required",
            format!("{what} changes the server and must be explicitly confirmed."),
        )
    }
    pub fn storage(e: impl std::fmt::Display) -> Self {
        Self::new(ErrorCode::Storage, "Storage error", "Brainbox VPS could not read or write its local database.")
            .details(e.to_string())
    }
    pub fn command_failed(cmd_desc: &str, exit: Option<u32>, stderr: &str) -> Self {
        let msg = match exit {
            Some(c) => format!("{cmd_desc} failed (exit code {c})."),
            None => format!("{cmd_desc} failed."),
        };
        let mut e = Self::new(ErrorCode::CommandFailed, "Command failed", msg).details(stderr.trim().to_string());
        let low = stderr.to_ascii_lowercase();
        if low.contains("permission denied") || low.contains("operation not permitted") {
            e.code = ErrorCode::PermissionDenied;
            e.title = "Permission denied".into();
            e.causes = vec![
                "Your SSH user does not have permission for this action".into(),
                "The action may require root (sudo)".into(),
            ];
        }
        e
    }
}

/// Context used to produce precise network error messages.
#[derive(Debug, Clone, Default)]
pub struct NetCtx {
    pub host: String,
    pub port: u16,
    pub what: &'static str,
}

impl NetCtx {
    pub fn ssh(host: &str, port: u16) -> Self {
        Self { host: host.to_string(), port, what: "SSH" }
    }
}

/// Convert an I/O error raised while establishing a network connection into a
/// readable explanation.
pub fn humanize_net_io(e: &std::io::Error, ctx: &NetCtx) -> AppError {
    use std::io::ErrorKind as K;
    let raw = e.to_string();
    let low = raw.to_ascii_lowercase();
    let port = ctx.port;
    let host = &ctx.host;
    let what = if ctx.what.is_empty() { "SSH" } else { ctx.what };
    if low.contains("failed to lookup address")
        || low.contains("no such host")
        || low.contains("name or service not known")
        || low.contains("nodename nor servname")
        || low.contains("temporary failure in name resolution")
        || raw.contains("os error 11001")
    {
        return AppError::new(ErrorCode::HostNotFound, "Host not found", format!("Could not find a server named \"{host}\"."))
            .causes([
                "The hostname may be misspelled",
                "DNS may not be resolving this name",
                "You may be offline",
            ])
            .details(raw);
    }
    match e.kind() {
        K::ConnectionRefused => AppError::new(
            ErrorCode::ConnectionRefused,
            "Connection refused",
            format!("Unable to connect to {what} on port {port}."),
        )
        .causes([
            format!("The {what} service on {host} may be offline"),
            format!("Port {port} may be wrong or blocked"),
            "A firewall may be blocking the connection".to_string(),
        ])
        .details(raw),
        K::TimedOut | K::WouldBlock => AppError::new(
            ErrorCode::ConnectionTimeout,
            "Connection timed out",
            format!("{host} did not respond on port {port} in time."),
        )
        .causes([
            "The server may be powered off or overloaded".to_string(),
            "A firewall may be silently dropping traffic".to_string(),
            format!("Port {port} may be wrong"),
        ])
        .details(raw),
        K::ConnectionReset | K::ConnectionAborted | K::BrokenPipe | K::UnexpectedEof => AppError::new(
            ErrorCode::Disconnected,
            "Connection lost",
            format!("The connection to {host} was closed unexpectedly."),
        )
        .causes([
            "The server closed the connection (e.g. fail2ban, MaxStartups, or a restart)",
            "Your network connection dropped",
        ])
        .details(raw),
        K::PermissionDenied => AppError::new(ErrorCode::PermissionDenied, "Permission denied", raw.clone()).details(raw),
        _ => {
            if low.contains("unreachable") || raw.contains("os error 10065") || raw.contains("os error 113") {
                AppError::new(ErrorCode::HostUnreachable, "Host unreachable", format!("No network route to {host}."))
                    .causes(["The server's network may be down", "Your VPN or network may be disconnected"])
                    .details(raw)
            } else if low.contains("network is unreachable") || raw.contains("os error 10051") {
                AppError::new(ErrorCode::NetworkDown, "Network unavailable", "Your computer appears to be offline.")
                    .details(raw)
            } else {
                AppError::new(ErrorCode::Io, "Network error", format!("Could not reach {host}:{port}.")).details(raw)
            }
        }
    }
}

/// Map an I/O error from a filesystem operation (local).
pub fn humanize_fs_io(e: &std::io::Error, path: &str) -> AppError {
    use std::io::ErrorKind as K;
    let raw = e.to_string();
    match e.kind() {
        K::NotFound => AppError::new(ErrorCode::NotFound, "Not found", format!("\"{path}\" does not exist.")).details(raw),
        K::PermissionDenied => AppError::new(
            ErrorCode::PermissionDenied,
            "Permission denied",
            format!("You don't have permission to access \"{path}\"."),
        )
        .causes(["The file may be in use by another program", "The folder may be protected"])
        .details(raw),
        K::AlreadyExists => {
            AppError::new(ErrorCode::AlreadyExists, "Already exists", format!("\"{path}\" already exists.")).details(raw)
        }
        _ => AppError::new(ErrorCode::Io, "File error", format!("Operation on \"{path}\" failed.")).details(raw),
    }
}

/// Map a russh-sftp error.
pub fn humanize_sftp(e: &russh_sftp::client::error::Error, path: &str) -> AppError {
    use russh_sftp::client::error::Error as E;
    use russh_sftp::protocol::StatusCode as S;
    let raw = e.to_string();
    match e {
        E::Status(st) => match st.status_code {
            S::NoSuchFile => {
                AppError::new(ErrorCode::NotFound, "Not found", format!("\"{path}\" does not exist on the server.")).details(raw)
            }
            S::PermissionDenied => AppError::new(
                ErrorCode::PermissionDenied,
                "Permission denied",
                format!("Your SSH user cannot access \"{path}\"."),
            )
            .causes(["The file is owned by another user (often root)", "Use the terminal with sudo if you need elevated access"])
            .details(raw),
            S::Failure => {
                let low = st.error_message.to_ascii_lowercase();
                if low.contains("exist") {
                    AppError::new(ErrorCode::AlreadyExists, "Already exists", format!("\"{path}\" already exists.")).details(raw)
                } else if low.contains("not empty") {
                    AppError::new(ErrorCode::CommandFailed, "Folder not empty", format!("\"{path}\" is not empty.")).details(raw)
                } else {
                    AppError::new(ErrorCode::Io, "File operation failed", format!("The server refused the operation on \"{path}\"."))
                        .causes(["The disk may be full", "The path may be read-only", "A file with the same name may exist"])
                        .details(raw)
                }
            }
            S::OpUnsupported => {
                AppError::new(ErrorCode::Unsupported, "Not supported", "The server's SFTP does not support this operation.").details(raw)
            }
            _ => AppError::new(ErrorCode::Io, "File operation failed", format!("Operation on \"{path}\" failed.")).details(raw),
        },
        E::Timeout => AppError::new(ErrorCode::ConnectionTimeout, "Server not responding", "The SFTP request timed out.")
            .causes(["The connection may be slow or lost", "The server may be overloaded"])
            .details(raw),
        _ => AppError::new(ErrorCode::Io, "File transfer error", format!("Operation on \"{path}\" failed.")).details(raw),
    }
}

pub fn humanize_russh(e: &russh::Error, ctx: &NetCtx) -> AppError {
    use russh::Error as R;
    let raw = format!("{e}");
    match e {
        R::IO(io) => humanize_net_io(io, ctx),
        R::ConnectionTimeout | R::KeepaliveTimeout | R::InactivityTimeout => AppError::new(
            ErrorCode::ConnectionTimeout,
            "Connection timed out",
            format!("{} stopped responding.", ctx.host),
        )
        .causes(["The network connection may have dropped", "The server may be overloaded or rebooting"])
        .details(raw),
        R::Disconnect | R::HUP | R::SendError | R::RecvError => AppError::new(
            ErrorCode::Disconnected,
            "Disconnected",
            format!("The SSH connection to {} was closed.", ctx.host),
        )
        .details(raw),
        R::UnknownKey => AppError::new(
            ErrorCode::HostKeyRejected,
            "Host key not trusted",
            "The server's identity was not accepted, so the connection was stopped.",
        )
        .details(raw),
        R::NoCommonAlgo { .. } => AppError::new(
            ErrorCode::Unsupported,
            "Incompatible server",
            "The server and Brainbox VPS share no common encryption algorithm.",
        )
        .causes(["The server may be very old and only support deprecated algorithms"])
        .details(raw),
        R::ChannelOpenFailure(_) => AppError::new(
            ErrorCode::CommandFailed,
            "Server refused a channel",
            "The server refused to open a new session channel.",
        )
        .causes(["MaxSessions may be reached on the server", "Port forwarding may be disabled (AllowTcpForwarding)"])
        .details(raw),
        _ => {
            if raw.to_ascii_lowercase().contains("connection refused") {
                return AppError::new(ErrorCode::ConnectionRefused, "Connection refused", format!("Unable to connect to SSH on port {}.", ctx.port))
                    .causes(["SSH service may be offline", format!("Port {} may be blocked", ctx.port).as_str(), "Firewall may be blocking the connection"])
                    .details(raw);
            }
            AppError::new(ErrorCode::Io, "SSH error", format!("An SSH protocol error occurred with {}.", ctx.host)).details(raw)
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::storage(e)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::new(ErrorCode::Internal, "Data error", "Could not read stored data.").details(e.to_string())
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(e: tokio::task::JoinError) -> Self {
        AppError::internal(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refused_message_is_human() {
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "Connection refused (os error 111)");
        let e = humanize_net_io(&io, &NetCtx::ssh("example.com", 22));
        assert_eq!(e.code, ErrorCode::ConnectionRefused);
        assert_eq!(e.message, "Unable to connect to SSH on port 22.");
        assert!(e.causes.iter().any(|c| c.contains("firewall") || c.contains("Firewall")));
        assert_eq!(e.details.as_deref(), Some("Connection refused (os error 111)"));
    }

    #[test]
    fn dns_failure_detected() {
        let io = std::io::Error::other("failed to lookup address information: Name or service not known");
        let e = humanize_net_io(&io, &NetCtx::ssh("nope.invalid", 22));
        assert_eq!(e.code, ErrorCode::HostNotFound);
    }

    #[test]
    fn permission_in_stderr_maps() {
        let e = AppError::command_failed("Restarting nginx", Some(1), "Failed: Permission denied");
        assert_eq!(e.code, ErrorCode::PermissionDenied);
    }
}
