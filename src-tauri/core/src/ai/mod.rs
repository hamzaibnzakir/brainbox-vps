//! Brainbox AI assistant.
//!
//! - The model can only touch the server through explicit tools.
//! - Read-only tools gather information (optionally without asking).
//! - Anything that changes the server becomes a *proposal*: the user sees the
//!   exact command and must approve it before Brainbox executes it.
//! - Tool output is redacted for obvious secrets before it is sent to the
//!   provider, and known secret files are never read for the model.

pub mod provider;
pub mod tools;

use crate::error::{AppError, ErrorCode, Result};
use crate::model::*;
use crate::privileged::SudoCache;
use crate::security::policy::assess;
use crate::ssh::exec::{exec, ExecOptions};
use crate::ssh::ConnectionManager;
use crate::storage::{Storage, AI_KEY_ID};
use parking_lot::Mutex;
use provider::{AiMessage, ModelReply, Provider, ToolCall, ToolResult};
use std::collections::HashMap;
use std::sync::Arc;

const MAX_STEPS: usize = 14;
pub const MAX_TOOL_OUTPUT: usize = 12_000;

struct Pending {
    proposal: AiProposal,
    call_id: String,
    /// Results already computed for other tool calls in the same model turn.
    done: Vec<ToolResult>,
    /// Tool calls from that turn still to be handled after the decision.
    remaining: Vec<ToolCall>,
}

struct Chat {
    server_id: String,
    messages: Vec<AiMessage>,
    items: Vec<AiChatItem>,
    pending: Option<Pending>,
}

pub struct AiService {
    conns: Arc<ConnectionManager>,
    storage: Arc<Storage>,
    #[allow(dead_code)]
    sudo: Arc<SudoCache>,
    chats: Mutex<HashMap<String, Chat>>,
    provider_override: Mutex<Option<Arc<dyn Provider>>>,
}

fn system_prompt(server: &ServerProfile, os: &str) -> String {
    format!(
        "You are Brainbox AI, a senior Linux/DevOps assistant inside the Brainbox VPS desktop app.\n\
         You are helping with the server \"{}\" ({}@{}:{}){}.\n\n\
         Rules:\n\
         1. Investigate with the read-only tools first. Base conclusions on tool output, not guesses.\n\
         2. You can NEVER change the server directly. To change anything (restart, install, edit, delete, kill…), call \
            `propose_command` with one exact shell command and a short reason. The user reviews and approves it; then you get the output.\n\
         3. Propose one change at a time and prefer the least destructive fix. Mention risks (downtime, data loss).\n\
         4. Never ask for or reveal passwords, private keys or tokens. Some output may be [REDACTED].\n\
         5. Answer concisely in Markdown. Put commands in code blocks. Say clearly when you are unsure.",
        server.name,
        server.username,
        server.host,
        server.port,
        if os.is_empty() { String::new() } else { format!(", running {os}") }
    )
}

impl AiService {
    pub fn new(conns: Arc<ConnectionManager>, storage: Arc<Storage>, sudo: Arc<SudoCache>) -> Self {
        Self { conns, storage, sudo, chats: Mutex::new(HashMap::new()), provider_override: Mutex::new(None) }
    }

    /// Replace the HTTP provider (tests).
    pub fn set_provider(&self, p: Option<Arc<dyn Provider>>) {
        *self.provider_override.lock() = p;
    }

    fn provider(&self) -> Result<(Arc<dyn Provider>, AiSettings)> {
        let settings = self.storage.settings()?.ai;
        if let Some(p) = self.provider_override.lock().clone() {
            return Ok((p, settings));
        }
        if !settings.enabled {
            return Err(AppError::new(ErrorCode::Ai, "AI assistant is off", "Enable Brainbox AI in Settings → AI to use the assistant."));
        }
        let key = self.storage.get_secret_raw(AI_KEY_ID)?.ok_or_else(|| {
            AppError::new(ErrorCode::Ai, "No API key", "Add an API key in Settings → AI.")
        })?;
        Ok((provider::http_provider(&settings, key), settings))
    }

    pub fn new_chat(&self, server_id: &str) -> Result<String> {
        self.storage.get_server(server_id)?;
        let id = uuid::Uuid::new_v4().to_string();
        self.chats.lock().insert(id.clone(), Chat { server_id: server_id.into(), messages: vec![], items: vec![], pending: None });
        Ok(id)
    }

    pub fn items(&self, chat_id: &str) -> Vec<AiChatItem> {
        self.chats.lock().get(chat_id).map(|c| c.items.clone()).unwrap_or_default()
    }

    pub fn delete_chat(&self, chat_id: &str) {
        self.chats.lock().remove(chat_id);
    }

    fn result(&self, chat_id: &str) -> AiTurnResult {
        let chats = self.chats.lock();
        let c = chats.get(chat_id);
        AiTurnResult {
            chat_id: chat_id.into(),
            items: c.map(|c| c.items.clone()).unwrap_or_default(),
            pending: c.and_then(|c| c.pending.as_ref().map(|p| p.proposal.clone())),
        }
    }

    pub async fn send(&self, chat_id: &str, text: &str) -> Result<AiTurnResult> {
        {
            let mut chats = self.chats.lock();
            let c = chats.get_mut(chat_id).ok_or_else(|| AppError::new(ErrorCode::NotFound, "Chat not found", "Start a new conversation."))?;
            if c.pending.is_some() {
                return Err(AppError::new(ErrorCode::InvalidInput, "Decision needed", "Approve or reject the proposed command first."));
            }
            c.messages.push(AiMessage::User(text.to_string()));
            c.items.push(AiChatItem::User { text: text.to_string() });
        }
        self.run_loop(chat_id).await?;
        Ok(self.result(chat_id))
    }

    /// Approve or reject the pending proposal, then continue the conversation.
    pub async fn decide(&self, chat_id: &str, proposal_id: &str, approve: bool) -> Result<AiTurnResult> {
        let (pending, server_id) = {
            let mut chats = self.chats.lock();
            let c = chats.get_mut(chat_id).ok_or_else(|| AppError::new(ErrorCode::NotFound, "Chat not found", "Start a new conversation."))?;
            match &c.pending {
                Some(p) if p.proposal.id == proposal_id => {}
                _ => return Err(AppError::new(ErrorCode::NotFound, "No such proposal", "This proposal is no longer pending.")),
            }
            (c.pending.take().unwrap(), c.server_id.clone())
        };
        let mut results = pending.done;
        let status;
        if approve {
            let out = match self.conns.require(&server_id) {
                Ok(conn) => exec(&conn, &pending.proposal.command, ExecOptions::timeout(600)).await,
                Err(e) => Err(e),
            };
            let (content, ok) = match out {
                Ok(o) => (tools::format_exec(&o), o.exit_code == Some(0)),
                Err(e) => (format!("Execution failed: {} — {}", e.title, e.message), false),
            };
            status = if ok { "executed" } else { "failed" };
            let content = tools::redact(&content);
            self.push_item(chat_id, AiChatItem::Tool { name: "run_approved_command".into(), input: pending.proposal.command.clone(), output: truncate(&content), ok });
            results.push(ToolResult { id: pending.call_id.clone(), content: truncate(&content), is_error: !ok });
        } else {
            status = "rejected";
            results.push(ToolResult { id: pending.call_id.clone(), content: "The user rejected this command. Do not run it; suggest an alternative or ask what they prefer.".into(), is_error: true });
        }
        // Update the proposal item's status.
        {
            let mut chats = self.chats.lock();
            if let Some(c) = chats.get_mut(chat_id) {
                for it in c.items.iter_mut().rev() {
                    if let AiChatItem::Proposal { proposal, status: s } = it {
                        if proposal.id == proposal_id {
                            *s = status.into();
                            break;
                        }
                    }
                }
            }
        }
        // Handle the remaining calls from the same turn.
        let paused = self.handle_calls(chat_id, &server_id, pending.remaining, &mut results).await?;
        if !paused {
            self.with_chat(chat_id, |c| c.messages.push(AiMessage::ToolResults(results)));
            self.run_loop(chat_id).await?;
        }
        Ok(self.result(chat_id))
    }

    fn push_item(&self, chat_id: &str, item: AiChatItem) {
        self.with_chat(chat_id, |c| c.items.push(item));
    }

    fn with_chat<F: FnOnce(&mut Chat)>(&self, chat_id: &str, f: F) {
        if let Some(c) = self.chats.lock().get_mut(chat_id) {
            f(c)
        }
    }

    /// Execute tool calls; returns true if the loop paused on a proposal.
    async fn handle_calls(&self, chat_id: &str, server_id: &str, calls: Vec<ToolCall>, results: &mut Vec<ToolResult>) -> Result<bool> {
        let settings = self.storage.settings()?.ai;
        let mut iter = calls.into_iter();
        while let Some(call) = iter.next() {
            let proposal = if call.name == "propose_command" {
                let cmd = call.input["command"].as_str().unwrap_or("").trim().to_string();
                let reason = call.input["reason"].as_str().unwrap_or("").to_string();
                if cmd.is_empty() {
                    results.push(ToolResult { id: call.id.clone(), content: "Error: `command` is required.".into(), is_error: true });
                    continue;
                }
                Some(AiProposal { id: uuid::Uuid::new_v4().to_string(), server_id: server_id.into(), risk: assess(&cmd).risk.max(CommandRisk::Mutating), command: cmd, reason })
            } else if call.name == "run_readonly_command" && !settings.auto_run_read_only {
                let cmd = call.input["command"].as_str().unwrap_or("").to_string();
                Some(AiProposal { id: uuid::Uuid::new_v4().to_string(), server_id: server_id.into(), risk: assess(&cmd).risk, command: cmd, reason: "Read-only inspection".into() })
            } else {
                None
            };
            if let Some(p) = proposal {
                self.with_chat(chat_id, |c| {
                    c.items.push(AiChatItem::Proposal { proposal: p.clone(), status: "pending".into() });
                    c.pending = Some(Pending { proposal: p, call_id: call.id.clone(), done: std::mem::take(results), remaining: iter.collect() });
                });
                return Ok(true);
            }
            let conn = self.conns.require(server_id);
            let (out, ok) = match conn {
                Ok(c) => tools::execute(&c, &call.name, &call.input).await,
                Err(e) => (format!("Error: {}", e.message), false),
            };
            let out = truncate(&tools::redact(&out));
            self.push_item(chat_id, AiChatItem::Tool { name: call.name.clone(), input: tools::describe_input(&call.input), output: out.clone(), ok });
            results.push(ToolResult { id: call.id, content: out, is_error: !ok });
        }
        Ok(false)
    }

    async fn run_loop(&self, chat_id: &str) -> Result<()> {
        let (provider, _settings) = self.provider()?;
        let server_id = self.chats.lock().get(chat_id).map(|c| c.server_id.clone()).unwrap_or_default();
        let profile = self.storage.get_server(&server_id)?;
        let os = match self.conns.get(&server_id) {
            Some(c) => c.probe_get("ai_os").unwrap_or_default(),
            None => String::new(),
        };
        let system = system_prompt(&profile, &os);
        for _ in 0..MAX_STEPS {
            let msgs = self.chats.lock().get(chat_id).map(|c| c.messages.clone()).unwrap_or_default();
            let reply: ModelReply = provider.complete(&system, &msgs, &tools::definitions()).await?;
            if !reply.text.trim().is_empty() {
                self.push_item(chat_id, AiChatItem::Assistant { text: reply.text.clone() });
            }
            self.with_chat(chat_id, |c| c.messages.push(AiMessage::Assistant { text: reply.text.clone(), calls: reply.calls.clone() }));
            if reply.calls.is_empty() {
                return Ok(());
            }
            let mut results = Vec::new();
            if self.handle_calls(chat_id, &server_id, reply.calls, &mut results).await? {
                return Ok(());
            }
            self.with_chat(chat_id, |c| c.messages.push(AiMessage::ToolResults(results)));
        }
        self.push_item(chat_id, AiChatItem::Assistant { text: "_I stopped after many investigation steps. Ask me to continue if needed._".into() });
        Ok(())
    }
}

pub fn truncate(s: &str) -> String {
    if s.len() <= MAX_TOOL_OUTPUT {
        return s.to_string();
    }
    let mut cut = MAX_TOOL_OUTPUT;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n…[output truncated, {} more bytes]", &s[..cut], s.len() - cut)
}
