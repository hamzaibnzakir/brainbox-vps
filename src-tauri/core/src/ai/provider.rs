//! Model providers: Anthropic Messages API and OpenAI-compatible chat APIs
//! (OpenAI, OpenRouter, Ollama, LM Studio, DeepSeek…).

use crate::error::{AppError, ErrorCode, Result};
use crate::model::{AiProviderKind, AiSettings};
use crate::security::SecretString;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub id: String,
    pub content: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AiMessage {
    User(String),
    Assistant { text: String, calls: Vec<ToolCall> },
    ToolResults(Vec<ToolResult>),
}

#[derive(Debug, Clone, Default)]
pub struct ModelReply {
    pub text: String,
    pub calls: Vec<ToolCall>,
}

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    async fn complete(&self, system: &str, messages: &[AiMessage], tools: &[ToolDef]) -> Result<ModelReply>;
}

fn ai_err(msg: impl Into<String>, details: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Ai, "AI request failed", msg).details(details)
}

// ───────────── Anthropic ─────────────

pub fn anthropic_body(model: &str, system: &str, messages: &[AiMessage], tools: &[ToolDef]) -> Value {
    let mut msgs = Vec::new();
    for m in messages {
        match m {
            AiMessage::User(t) => msgs.push(json!({"role":"user","content":[{"type":"text","text":t}]})),
            AiMessage::Assistant { text, calls } => {
                let mut content = Vec::new();
                if !text.is_empty() {
                    content.push(json!({"type":"text","text":text}));
                }
                for c in calls {
                    content.push(json!({"type":"tool_use","id":c.id,"name":c.name,"input":c.input}));
                }
                msgs.push(json!({"role":"assistant","content":content}));
            }
            AiMessage::ToolResults(rs) => {
                let content: Vec<Value> = rs.iter().map(|r| json!({"type":"tool_result","tool_use_id":r.id,"content":r.content,"is_error":r.is_error})).collect();
                msgs.push(json!({"role":"user","content":content}));
            }
        }
    }
    json!({
        "model": model,
        "max_tokens": 4096,
        "system": system,
        "messages": msgs,
        "tools": tools.iter().map(|t| json!({"name":t.name,"description":t.description,"input_schema":t.schema})).collect::<Vec<_>>(),
    })
}

pub fn parse_anthropic(v: &Value) -> Result<ModelReply> {
    if let Some(e) = v.get("error") {
        return Err(ai_err(e["message"].as_str().unwrap_or("The provider returned an error.").to_string(), v.to_string()));
    }
    let mut r = ModelReply::default();
    for b in v["content"].as_array().cloned().unwrap_or_default() {
        match b["type"].as_str() {
            Some("text") => r.text.push_str(b["text"].as_str().unwrap_or("")),
            Some("tool_use") => r.calls.push(ToolCall { id: b["id"].as_str().unwrap_or("").into(), name: b["name"].as_str().unwrap_or("").into(), input: b["input"].clone() }),
            _ => {}
        }
    }
    Ok(r)
}

// ───────────── OpenAI-compatible ─────────────

pub fn openai_body(model: &str, system: &str, messages: &[AiMessage], tools: &[ToolDef]) -> Value {
    let mut msgs = vec![json!({"role":"system","content":system})];
    for m in messages {
        match m {
            AiMessage::User(t) => msgs.push(json!({"role":"user","content":t})),
            AiMessage::Assistant { text, calls } => {
                let mut o = json!({"role":"assistant","content": if text.is_empty() { Value::Null } else { json!(text) }});
                if !calls.is_empty() {
                    o["tool_calls"] = json!(calls.iter().map(|c| json!({"id":c.id,"type":"function","function":{"name":c.name,"arguments":c.input.to_string()}})).collect::<Vec<_>>());
                }
                msgs.push(o);
            }
            AiMessage::ToolResults(rs) => {
                for r in rs {
                    msgs.push(json!({"role":"tool","tool_call_id":r.id,"content":r.content}));
                }
            }
        }
    }
    json!({
        "model": model,
        "messages": msgs,
        "tools": tools.iter().map(|t| json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.schema}})).collect::<Vec<_>>(),
    })
}

pub fn parse_openai(v: &Value) -> Result<ModelReply> {
    if let Some(e) = v.get("error") {
        let msg = e["message"].as_str().or(e.as_str()).unwrap_or("The provider returned an error.").to_string();
        return Err(ai_err(msg, v.to_string()));
    }
    let m = &v["choices"][0]["message"];
    let mut r = ModelReply { text: m["content"].as_str().unwrap_or("").to_string(), calls: vec![] };
    for c in m["tool_calls"].as_array().cloned().unwrap_or_default() {
        let args = c["function"]["arguments"].as_str().unwrap_or("{}");
        r.calls.push(ToolCall {
            id: c["id"].as_str().unwrap_or("").into(),
            name: c["function"]["name"].as_str().unwrap_or("").into(),
            input: serde_json::from_str(args).unwrap_or_else(|_| json!({})),
        });
    }
    Ok(r)
}

// ───────────── HTTP ─────────────

pub struct HttpProvider {
    kind: AiProviderKind,
    base: String,
    model: String,
    key: SecretString,
    client: reqwest::Client,
}

pub fn http_provider(s: &AiSettings, key: SecretString) -> Arc<dyn Provider> {
    Arc::new(HttpProvider {
        kind: s.provider,
        base: s.base_url.trim_end_matches('/').to_string(),
        model: s.model.clone(),
        key,
        client: reqwest::Client::builder().timeout(std::time::Duration::from_secs(180)).build().unwrap_or_default(),
    })
}

#[async_trait::async_trait]
impl Provider for HttpProvider {
    async fn complete(&self, system: &str, messages: &[AiMessage], tools: &[ToolDef]) -> Result<ModelReply> {
        let (url, body, req) = match self.kind {
            AiProviderKind::Anthropic => {
                let url = if self.base.ends_with("/v1") { format!("{}/messages", self.base) } else { format!("{}/v1/messages", self.base) };
                let body = anthropic_body(&self.model, system, messages, tools);
                let req = self.client.post(&url).header("x-api-key", self.key.expose()).header("anthropic-version", "2023-06-01");
                (url, body, req)
            }
            AiProviderKind::OpenaiCompatible => {
                let url = format!("{}/chat/completions", self.base);
                let body = openai_body(&self.model, system, messages, tools);
                let req = self.client.post(&url).bearer_auth(self.key.expose());
                (url, body, req)
            }
        };
        let resp = req.json(&body).send().await.map_err(|e| {
            AppError::new(ErrorCode::Ai, "Cannot reach the AI provider", format!("Could not connect to {url}."))
                .causes(["Check your internet connection", "Check the provider URL in Settings → AI"])
                .details(e.to_string())
        })?;
        let status = resp.status();
        let v: Value = resp.json().await.map_err(|e| ai_err("The provider sent an unreadable response.", e.to_string()))?;
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(AppError::new(ErrorCode::Ai, "AI key rejected", "The provider rejected the API key. Update it in Settings → AI.").details(v.to_string()));
        }
        if status.as_u16() == 429 {
            return Err(AppError::new(ErrorCode::Ai, "Rate limited", "The AI provider is rate-limiting requests. Wait a moment and try again.").details(v.to_string()));
        }
        if !status.is_success() && v.get("error").is_none() {
            return Err(ai_err(format!("The provider returned HTTP {status}."), v.to_string()));
        }
        match self.kind {
            AiProviderKind::Anthropic => parse_anthropic(&v),
            AiProviderKind::OpenaiCompatible => parse_openai(&v),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convo() -> Vec<AiMessage> {
        vec![
            AiMessage::User("why slow?".into()),
            AiMessage::Assistant { text: "Checking.".into(), calls: vec![ToolCall { id: "t1".into(), name: "list_processes".into(), input: json!({"sort_by":"cpu"}) }] },
            AiMessage::ToolResults(vec![ToolResult { id: "t1".into(), content: "PID ...".into(), is_error: false }]),
        ]
    }

    #[test]
    fn anthropic_roundtrip() {
        let b = anthropic_body("m", "sys", &convo(), &[ToolDef { name: "x".into(), description: "d".into(), schema: json!({"type":"object"}) }]);
        assert_eq!(b["system"], "sys");
        assert_eq!(b["messages"][1]["content"][1]["type"], "tool_use");
        assert_eq!(b["messages"][2]["content"][0]["tool_use_id"], "t1");
        assert_eq!(b["tools"][0]["input_schema"]["type"], "object");
        let r = parse_anthropic(&json!({"content":[{"type":"text","text":"Hi"},{"type":"tool_use","id":"a","name":"propose_command","input":{"command":"x"}}],"stop_reason":"tool_use"})).unwrap();
        assert_eq!(r.text, "Hi");
        assert_eq!(r.calls[0].input["command"], "x");
        assert!(parse_anthropic(&json!({"type":"error","error":{"message":"bad"}})).is_err());
    }

    #[test]
    fn openai_roundtrip() {
        let b = openai_body("m", "sys", &convo(), &[]);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][2]["tool_calls"][0]["function"]["arguments"], "{\"sort_by\":\"cpu\"}");
        assert_eq!(b["messages"][3]["role"], "tool");
        let r = parse_openai(&json!({"choices":[{"message":{"content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"disk_usage","arguments":"{\"path\":\"/\"}"}}]}}]})).unwrap();
        assert_eq!(r.calls[0].name, "disk_usage");
        assert_eq!(r.calls[0].input["path"], "/");
    }
}
