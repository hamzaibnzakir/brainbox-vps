//! Brainbox VPS core library.
//!
//! Everything that talks to servers or disk lives here, independent of the
//! desktop shell, so it can be unit- and integration-tested headlessly.

pub mod ai;
pub mod broadcast;
pub mod docker;
pub mod error;
pub mod events;
pub mod filesystem;
pub mod git;
pub mod logs;
pub mod model;
pub mod monitoring;
pub mod privileged;
pub mod rt;
pub mod security;
pub mod sftp;
pub mod ssh;
pub mod sshconfig;
pub mod storage;
pub mod terminal;
pub mod tunnels;

pub use error::{AppError, ErrorCode, Result};
