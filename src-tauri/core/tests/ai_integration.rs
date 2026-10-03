//! AI agent loop with a scripted model, executing real tools on the test server.

mod common;

use brainbox_core::ai::provider::{AiMessage, ModelReply, Provider, ToolCall, ToolDef};
use brainbox_core::ai::AiService;
use brainbox_core::model::*;
use brainbox_core::privileged::SudoCache;
use brainbox_core::ssh::exec::{exec, ExecOptions};
use common::*;
use parking_lot::Mutex;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::Arc;

struct Scripted {
    replies: Mutex<VecDeque<ModelReply>>,
    seen: Mutex<Vec<Vec<AiMessage>>>,
}

#[async_trait::async_trait]
impl Provider for Scripted {
    async fn complete(&self, system: &str, messages: &[AiMessage], tools: &[ToolDef]) -> brainbox_core::Result<ModelReply> {
        assert!(system.contains("propose_command"));
        assert!(tools.iter().any(|t| t.name == "run_readonly_command"));
        self.seen.lock().push(messages.to_vec());
        Ok(self.replies.lock().pop_front().unwrap_or(ModelReply { text: "done".into(), calls: vec![] }))
    }
}

fn call(id: &str, name: &str, input: serde_json::Value) -> ToolCall {
    ToolCall { id: id.into(), name: name.into(), input }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_only_first_then_approval_gated_changes() {
    require_ssh!();
    let h = harness();
    let (p, c) = connected(&h, "ai").await;
    let marker = format!("/tmp/{}", unique("ai-marker"));
    let ai = AiService::new(h.mgr.clone(), h.storage.clone(), Arc::new(SudoCache::default()));
    let scripted = Arc::new(Scripted {
        replies: Mutex::new(VecDeque::from(vec![
            ModelReply {
                text: "Let me look.".into(),
                calls: vec![
                    call("c1", "list_processes", json!({"sort_by":"cpu","limit":5})),
                    call("c2", "run_readonly_command", json!({"command":"rm -rf /tmp/whatever"})),
                    call("c3", "run_readonly_command", json!({"command":"cat /home/bbx/.env"})),
                ],
            },
            ModelReply { text: "I suggest creating the marker.".into(), calls: vec![call("c4", "propose_command", json!({"command": format!("touch {marker}"), "reason":"test"}))] },
            ModelReply { text: "Marker created. All good.".into(), calls: vec![] },
            ModelReply { text: "".into(), calls: vec![call("c5", "propose_command", json!({"command": format!("rm -f {marker}"), "reason":"cleanup"}))] },
            ModelReply { text: "OK, I won't delete it.".into(), calls: vec![] },
        ])),
        seen: Mutex::new(vec![]),
    });
    ai.set_provider(Some(scripted.clone()));
    let chat = ai.new_chat(&p.id).unwrap();

    let r = ai.send(&chat, "Why is my server slow?").await.unwrap();
    // Read-only tool ran; mutating "read-only" command and secret file were refused.
    let tools: Vec<_> = r.items.iter().filter_map(|i| if let AiChatItem::Tool { name, output, ok, .. } = i { Some((name.clone(), output.clone(), *ok)) } else { None }).collect();
    assert_eq!(tools.len(), 3);
    assert!(tools[0].2 && tools[0].1.contains("PID"));
    assert!(!tools[1].2 && tools[1].1.contains("not read-only"));
    assert!(!tools[2].2 && tools[2].1.contains("secrets"));
    // Paused on the proposal; nothing executed yet.
    let pending = r.pending.clone().expect("proposal pending");
    assert_eq!(pending.command, format!("touch {marker}"));
    assert!(pending.risk >= CommandRisk::Mutating);
    let check = exec(&c, &format!("test -e {marker} && echo yes || echo no"), ExecOptions::default()).await.unwrap();
    assert_eq!(check.stdout.trim(), "no", "must not run before approval");
    // Can't chat past a pending decision.
    assert!(ai.send(&chat, "hello?").await.is_err());

    let r = ai.decide(&chat, &pending.id, true).await.unwrap();
    assert!(r.pending.is_none());
    let check = exec(&c, &format!("test -e {marker} && echo yes || echo no"), ExecOptions::default()).await.unwrap();
    assert_eq!(check.stdout.trim(), "yes");
    assert!(matches!(r.items.last(), Some(AiChatItem::Assistant { text }) if text.contains("Marker created")));
    assert!(r.items.iter().any(|i| matches!(i, AiChatItem::Proposal { status, .. } if status == "executed")));

    // The model received results for every tool call of the first turn.
    let seen = scripted.seen.lock().clone();
    let tr = seen[1].iter().find_map(|m| if let AiMessage::ToolResults(r) = m { Some(r.clone()) } else { None }).unwrap();
    assert_eq!(tr.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["c1", "c2", "c3"]);

    // Rejection path.
    let r = ai.send(&chat, "Clean it up").await.unwrap();
    let p2 = r.pending.unwrap();
    let r = ai.decide(&chat, &p2.id, false).await.unwrap();
    assert!(r.items.iter().any(|i| matches!(i, AiChatItem::Proposal { status, .. } if status == "rejected")));
    let check = exec(&c, &format!("test -e {marker} && echo yes || echo no"), ExecOptions::default()).await.unwrap();
    assert_eq!(check.stdout.trim(), "yes", "rejected command never runs");
    exec(&c, &format!("rm -f {marker}"), ExecOptions::default()).await.unwrap();
}

#[tokio::test]
async fn disabled_ai_explains() {
    let h = harness();
    let p = add_password_server(&h, "x");
    let ai = AiService::new(h.mgr.clone(), h.storage.clone(), Arc::new(SudoCache::default()));
    let chat = ai.new_chat(&p.id).unwrap();
    let e = ai.send(&chat, "hi").await.unwrap_err();
    assert_eq!(e.title, "AI assistant is off");
}
