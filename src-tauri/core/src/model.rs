//! Shared data contract between Rust and TypeScript.
//!
//! Every type here derives `ts_rs::TS`; running `cargo test -p brainbox-core
//! export_bindings` regenerates `src/types/generated/*.ts` in the frontend so
//! the two sides cannot silently drift apart.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub type ServerId = String;

// ───────────────────────────── Servers ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AuthMethod {
    #[default]
    Password,
    Key,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProxyKind {
    Socks5,
    Http,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    /// True when a proxy password is stored in the vault.
    #[serde(default)]
    pub has_password: bool,
}

/// A saved server profile. Never contains secrets — only flags saying which
/// secrets exist in the encrypted vault.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerProfile {
    pub id: ServerId,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    /// Path to a private key on this computer (used when `auth_method == key`
    /// and no imported key is stored).
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub has_password: bool,
    #[serde(default)]
    pub has_passphrase: bool,
    /// True when a private key was imported into the encrypted vault.
    #[serde(default)]
    pub has_key_data: bool,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
    /// Another saved server used as an SSH jump host (ProxyJump).
    #[serde(default)]
    pub jump_host_id: Option<ServerId>,
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u32,
    #[serde(default = "default_timeout")]
    pub connect_timeout_secs: u32,
    #[serde(default = "default_true")]
    pub auto_reconnect: bool,
    /// Wrap terminals in tmux (when available) so shells survive disconnects.
    #[serde(default)]
    pub use_tmux: bool,
    #[serde(default)]
    pub startup_dir: Option<String>,
    #[serde(default)]
    pub startup_command: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub last_connected_at: Option<i64>,
}

fn default_keepalive() -> u32 {
    30
}
fn default_timeout() -> u32 {
    15
}
fn default_true() -> bool {
    true
}

/// How a secret should change when a server is saved.
#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(tag = "action", content = "value", rename_all = "snake_case")]
#[ts(export)]
pub enum SecretUpdate {
    #[default]
    Keep,
    Clear,
    Set(String),
}

/// Payload used to create or update a server.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub password: SecretUpdate,
    #[serde(default)]
    pub passphrase: SecretUpdate,
    /// PEM/OpenSSH private key content to import into the vault.
    #[serde(default)]
    pub key_data: SecretUpdate,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
    #[serde(default)]
    pub proxy_password: SecretUpdate,
    #[serde(default)]
    pub jump_host_id: Option<ServerId>,
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u32,
    #[serde(default = "default_timeout")]
    pub connect_timeout_secs: u32,
    #[serde(default = "default_true")]
    pub auto_reconnect: bool,
    #[serde(default)]
    pub use_tmux: bool,
    #[serde(default)]
    pub startup_dir: Option<String>,
    #[serde(default)]
    pub startup_command: Option<String>,
}

/// One host parsed from an OpenSSH config file, ready to be imported.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SshConfigHost {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub already_imported: bool,
}

// ───────────────────────────── Connection state ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected { since: i64 },
    Reconnecting { attempt: u32, next_retry_ms: u64 },
    Failed { error: crate::error::AppError },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConnectionStatus {
    pub server_id: ServerId,
    pub state: ConnectionState,
    #[serde(default)]
    pub latency_ms: Option<u32>,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub server_banner: Option<String>,
}

/// Asked of the user when a server presents an unknown or changed host key.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostKeyPrompt {
    pub request_id: String,
    pub server_id: ServerId,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    /// When set, the server presented a *different* key than the trusted one.
    #[serde(default)]
    pub previous_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HostKeyDecision {
    /// Trust permanently (stored in Brainbox's known hosts).
    Trust,
    /// Allow this connection only.
    Once,
    Reject,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub added_at: i64,
}

// ───────────────────────────── Terminals ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalOpenRequest {
    pub server_id: ServerId,
    pub cols: u32,
    pub rows: u32,
    /// Persistent tmux session name to create-or-attach. When `None` and the
    /// server has `use_tmux`, a fresh name is generated.
    #[serde(default)]
    pub tmux_session: Option<String>,
    /// Optional command instead of a login shell (e.g. `docker exec -it …`).
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalInfo {
    pub id: String,
    pub server_id: Option<ServerId>,
    pub title: String,
    #[serde(default)]
    pub tmux_session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum TerminalEvent {
    /// Raw output bytes, base64 encoded (keeps binary/partial UTF-8 intact).
    Data { data: String },
    /// The underlying connection dropped; the session will resume on reconnect.
    Suspended,
    /// Re-attached after a reconnect.
    Resumed,
    Exit { code: Option<u32> },
    Error { error: crate::error::AppError },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LocalShellInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub is_default: bool,
}

// ───────────────────────────── Files ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    /// For symlinks: whether the target is a directory.
    #[serde(default)]
    pub link_is_dir: bool,
    #[ts(type = "number")]
    pub size: u64,
    #[serde(default)]
    pub modified: Option<i64>,
    #[serde(default)]
    pub permissions: Option<u32>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DirListing {
    pub path: String,
    #[serde(default)]
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TextFile {
    pub path: String,
    pub content: String,
    /// Detected encoding ("utf-8" or "latin-1").
    pub encoding: String,
    #[ts(type = "number")]
    pub size: u64,
    #[serde(default)]
    pub modified: Option<i64>,
    #[serde(default)]
    pub permissions: Option<u32>,
    /// Line ending style detected ("lf" | "crlf").
    pub eol: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TransferState {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TransferRequest {
    pub server_id: ServerId,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TransferInfo {
    pub id: String,
    pub server_id: ServerId,
    pub direction: TransferDirection,
    pub name: String,
    pub local_path: String,
    pub remote_path: String,
    pub is_dir: bool,
    pub state: TransferState,
    #[ts(type = "number")]
    pub total_bytes: u64,
    #[ts(type = "number")]
    pub transferred_bytes: u64,
    pub files_total: u32,
    pub files_done: u32,
    /// Bytes per second (smoothed).
    pub speed_bps: f64,
    #[serde(default)]
    pub eta_secs: Option<u64>,
    #[serde(default)]
    pub current_file: Option<String>,
    #[serde(default)]
    pub error: Option<crate::error::AppError>,
    pub created_at: i64,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub finished_at: Option<i64>,
}

// ───────────────────────────── Exec / commands ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    #[serde(default)]
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CommandRisk {
    /// Only inspects state.
    ReadOnly,
    /// Changes state (restart, write, install…).
    Mutating,
    /// Potentially irreversible / destructive (rm -rf, mkfs, reboot…).
    Dangerous,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandAssessment {
    pub risk: CommandRisk,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub command: String,
    #[serde(default)]
    pub category: Option<String>,
    /// `None` = global command available on every server.
    #[serde(default)]
    pub server_id: Option<ServerId>,
    /// Accelerator such as "Ctrl+Alt+1".
    #[serde(default)]
    pub shortcut: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnippetInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub command: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub server_id: Option<ServerId>,
    #[serde(default)]
    pub shortcut: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BroadcastResult {
    pub broadcast_id: String,
    pub server_id: ServerId,
    pub server_name: String,
    #[serde(default)]
    pub output: Option<ExecOutput>,
    #[serde(default)]
    pub error: Option<crate::error::AppError>,
}

// ───────────────────────────── Monitoring ─────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SystemInfo {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub cpu_model: String,
    pub cpu_cores: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiskUsage {
    pub filesystem: String,
    pub fs_type: String,
    pub mount: String,
    #[ts(type = "number")]
    pub total_bytes: u64,
    #[ts(type = "number")]
    pub used_bytes: u64,
    #[ts(type = "number")]
    pub avail_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MetricsSnapshot {
    pub server_id: ServerId,
    pub timestamp: i64,
    pub cpu_percent: f64,
    pub cpu_cores: u32,
    #[ts(type = "number")]
    pub mem_total: u64,
    #[ts(type = "number")]
    pub mem_used: u64,
    #[ts(type = "number")]
    pub mem_available: u64,
    #[ts(type = "number")]
    pub mem_cached: u64,
    #[ts(type = "number")]
    pub swap_total: u64,
    #[ts(type = "number")]
    pub swap_used: u64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    #[ts(type = "number")]
    pub uptime_secs: u64,
    pub net_rx_bps: f64,
    pub net_tx_bps: f64,
    #[ts(type = "number")]
    pub net_rx_total: u64,
    #[ts(type = "number")]
    pub net_tx_total: u64,
    pub disks: Vec<DiskUsage>,
    pub process_count: u32,
    #[serde(default)]
    pub listening_ports: Option<u32>,
    #[serde(default)]
    pub latency_ms: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    pub state: String,
    pub cpu_percent: f64,
    pub mem_percent: f64,
    #[ts(type = "number")]
    pub rss_kb: u64,
    #[ts(type = "number")]
    pub elapsed_secs: u64,
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PortInfo {
    pub protocol: String,
    pub local_address: String,
    pub port: u16,
    pub state: String,
    #[serde(default)]
    pub process: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServiceInfo {
    pub name: String,
    pub description: String,
    pub load_state: String,
    pub active_state: String,
    pub sub_state: String,
    /// enabled / disabled / static / masked / unknown
    pub enabled_state: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
    Reload,
    Enable,
    Disable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Signal {
    Term,
    Kill,
    Hup,
    Int,
}

// ───────────────────────────── Logs ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum LogSource {
    System,
    Service { unit: String },
    Docker { container: String },
    File { path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LogStreamRequest {
    pub server_id: ServerId,
    pub source: LogSource,
    /// Number of historical lines to show before following.
    pub lines: u32,
    pub follow: bool,
    #[serde(default)]
    pub sudo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum StreamEvent {
    Lines { lines: Vec<String> },
    End { code: Option<u32> },
    Error { error: crate::error::AppError },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LogFileCandidate {
    pub path: String,
    #[ts(type = "number")]
    pub size: u64,
}

// ───────────────────────────── Docker ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DockerStatus {
    pub available: bool,
    #[serde(default)]
    pub version: Option<String>,
    /// True when docker commands are run through `sudo -n`.
    pub uses_sudo: bool,
    #[serde(default)]
    pub reason: Option<crate::error::AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub created: String,
    #[serde(default)]
    pub compose_project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DockerImage {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DockerNetwork {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DockerStats {
    pub id: String,
    pub name: String,
    pub cpu_percent: String,
    pub mem_usage: String,
    pub mem_percent: String,
    pub net_io: String,
    pub block_io: String,
    pub pids: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ContainerAction {
    Start,
    Stop,
    Restart,
    Pause,
    Unpause,
    Remove,
}

// ───────────────────────────── Git ─────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitStatus {
    pub path: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitFileChange {
    pub path: String,
    /// Index status letter (porcelain v2 XY[0]).
    pub staged: String,
    /// Worktree status letter (XY[1]).
    pub unstaged: String,
    pub untracked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitBranch {
    pub name: String,
    pub is_remote: bool,
    pub is_current: bool,
    pub commit: String,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitCommit {
    pub hash: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub subject: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum GitAction {
    Fetch,
    Pull,
    Push,
}

// ───────────────────────────── Tunnels ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TunnelKind {
    /// -L : local port → remote target
    Local,
    /// -R : remote port → local target
    Remote,
    /// -D : local SOCKS5 proxy through the server
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TunnelConfig {
    pub id: String,
    pub server_id: ServerId,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    /// Unused for dynamic tunnels.
    #[serde(default)]
    pub target_host: String,
    #[serde(default)]
    pub target_port: u16,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TunnelInput {
    pub server_id: ServerId,
    pub name: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    #[serde(default)]
    pub target_host: String,
    #[serde(default)]
    pub target_port: u16,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TunnelState {
    Stopped,
    Starting,
    Running,
    /// Waiting for the server connection to come back.
    Waiting,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TunnelStatus {
    pub id: String,
    pub state: TunnelState,
    pub active_connections: u32,
    #[ts(type = "number")]
    pub bytes_in: u64,
    #[ts(type = "number")]
    pub bytes_out: u64,
    #[serde(default)]
    pub error: Option<crate::error::AppError>,
}

// ───────────────────────────── Workspaces & settings ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub server_ids: Vec<ServerId>,
    /// Opaque UI layout state owned by the frontend (tabs, splits, panes,
    /// file locations, pinned tools, window layout).
    #[ts(type = "unknown")]
    pub layout: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ThemeMode {
    #[default]
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Density {
    Compact,
    #[default]
    Comfortable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct NotificationPrefs {
    pub enabled: bool,
    pub ssh_disconnected: bool,
    pub ssh_reconnected: bool,
    pub transfer_finished: bool,
    pub container_stopped: bool,
    pub server_unreachable: bool,
    pub command_finished: bool,
    /// Only notify about transfers/commands that took at least this long.
    pub min_duration_secs: u32,
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            ssh_disconnected: true,
            ssh_reconnected: true,
            transfer_finished: true,
            container_stopped: true,
            server_unreachable: true,
            command_finished: true,
            min_duration_secs: 10,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AiProviderKind {
    #[default]
    Anthropic,
    OpenaiCompatible,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AiSettings {
    pub enabled: bool,
    pub provider: AiProviderKind,
    pub base_url: String,
    pub model: String,
    /// True when an API key is stored in the vault.
    pub has_api_key: bool,
    /// Allow the assistant to run read-only inspection commands without asking.
    pub auto_run_read_only: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: AiProviderKind::Anthropic,
            base_url: "https://api.anthropic.com".into(),
            model: "claude-sonnet-5-5".into(),
            has_api_key: false,
            auto_run_read_only: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Settings {
    pub theme: ThemeMode,
    pub accent: String,
    pub density: Density,
    pub ui_font_size: u32,
    pub terminal_font_family: String,
    pub terminal_font_size: u32,
    pub terminal_line_height: f64,
    pub terminal_scrollback: u32,
    pub terminal_cursor_style: String,
    pub terminal_cursor_blink: bool,
    pub copy_on_select: bool,
    pub right_click_paste: bool,
    /// Ask before pasting text with more than one line into a terminal.
    pub confirm_multiline_paste: bool,
    pub monitor_interval_ms: u32,
    pub background_monitor_interval_ms: u32,
    pub default_use_tmux: bool,
    pub show_hidden_files: bool,
    pub transfer_concurrency: u32,
    pub confirm_dangerous_commands: bool,
    pub close_to_tray: bool,
    pub launch_at_startup: bool,
    pub check_updates: bool,
    pub restore_workspace: bool,
    pub editor_minimap: bool,
    pub editor_word_wrap: bool,
    pub editor_font_size: u32,
    pub notifications: NotificationPrefs,
    pub ai: AiSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: ThemeMode::Dark,
            accent: "#7c5cff".into(),
            density: Density::Comfortable,
            ui_font_size: 13,
            terminal_font_family: "\"Cascadia Code\", \"JetBrains Mono\", Consolas, monospace".into(),
            terminal_font_size: 14,
            terminal_line_height: 1.2,
            terminal_scrollback: 10_000,
            terminal_cursor_style: "bar".into(),
            terminal_cursor_blink: true,
            copy_on_select: false,
            right_click_paste: true,
            confirm_multiline_paste: true,
            monitor_interval_ms: 2000,
            background_monitor_interval_ms: 15000,
            default_use_tmux: false,
            show_hidden_files: false,
            transfer_concurrency: 3,
            confirm_dangerous_commands: true,
            close_to_tray: false,
            launch_at_startup: false,
            check_updates: true,
            restore_workspace: true,
            editor_minimap: true,
            editor_word_wrap: false,
            editor_font_size: 14,
            notifications: NotificationPrefs::default(),
            ai: AiSettings::default(),
        }
    }
}

// ───────────────────────────── AI ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiProposal {
    pub id: String,
    pub server_id: ServerId,
    pub command: String,
    pub reason: String,
    pub risk: CommandRisk,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "role", rename_all = "snake_case")]
#[ts(export)]
pub enum AiChatItem {
    User { text: String },
    Assistant { text: String },
    /// A tool the assistant ran (read-only, or approved by the user).
    Tool { name: String, input: String, output: String, ok: bool },
    Proposal { proposal: AiProposal, status: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AiTurnResult {
    pub chat_id: String,
    pub items: Vec<AiChatItem>,
    #[serde(default)]
    pub pending: Option<AiProposal>,
}

// ───────────────────────────── App events ─────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppNotification {
    pub kind: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub server_id: Option<ServerId>,
}
