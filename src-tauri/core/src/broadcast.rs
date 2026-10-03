//! Broadcast: run one command on many servers, results reported per server.

use crate::error::{AppError, ErrorCode, Result};
use crate::events::{names, EventSinkExt, SharedSink};
use crate::model::{BroadcastResult, CommandAssessment, CommandRisk};
use crate::security::policy::assess;
use crate::ssh::exec::{exec, ExecOptions};
use crate::ssh::ConnectionManager;
use std::sync::Arc;

pub fn check(command: &str, confirmed: bool) -> Result<CommandAssessment> {
    if command.trim().is_empty() {
        return Err(AppError::invalid("Enter a command to run."));
    }
    let a = assess(command);
    if a.risk >= CommandRisk::Mutating && !confirmed {
        let mut e = AppError::confirmation_required("This command");
        e.causes = a.reasons.clone();
        e.details = Some(format!("{:?}", a.risk));
        return Err(e);
    }
    Ok(a)
}

/// Run on every server concurrently. Each result is emitted as soon as it is
/// ready (`broadcast://result`) and all are returned at the end.
pub async fn run(conns: &Arc<ConnectionManager>, sink: &SharedSink, server_ids: &[String], command: &str, confirmed: bool, timeout_secs: u64) -> Result<(String, Vec<BroadcastResult>)> {
    check(command, confirmed)?;
    if server_ids.is_empty() {
        return Err(AppError::invalid("Select at least one server."));
    }
    let bid = uuid::Uuid::new_v4().to_string();
    let futs = server_ids.iter().map(|sid| {
        let conns = conns.clone();
        let sink = sink.clone();
        let sid = sid.clone();
        let bid = bid.clone();
        let command = command.to_string();
        async move {
            let name = conns.storage().get_server(&sid).map(|p| p.name).unwrap_or_else(|_| sid.clone());
            let r = match conns.require(&sid) {
                Ok(c) => match exec(&c, &command, ExecOptions::timeout(timeout_secs)).await {
                    Ok(o) => BroadcastResult { broadcast_id: bid.clone(), server_id: sid.clone(), server_name: name, output: Some(o), error: None },
                    Err(e) => BroadcastResult { broadcast_id: bid.clone(), server_id: sid.clone(), server_name: name, output: None, error: Some(e) },
                },
                Err(_) => BroadcastResult {
                    broadcast_id: bid.clone(),
                    server_id: sid.clone(),
                    server_name: name.clone(),
                    output: None,
                    error: Some(AppError::new(ErrorCode::NotConnected, "Not connected", format!("{name} is not connected."))),
                },
            };
            sink.emit(names::BROADCAST, &r);
            r
        }
    });
    let results = futures::future::join_all(futs).await;
    Ok((bid, results))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destructive_needs_confirmation() {
        assert!(check("uptime", false).is_ok());
        let e = check("git pull", false).unwrap_err();
        assert_eq!(e.code, ErrorCode::ConfirmationRequired);
        assert!(check("git pull", true).is_ok());
        let e = check("rm -rf /var/www", false).unwrap_err();
        assert_eq!(e.details.as_deref(), Some("Dangerous"));
    }
}
