//! Native CLI hooks: host event translation with neutral failure.
//!
//! Hooks read one JSON object from stdin and print one JSON object to stdout.
//! A missing daemon, deadline, or malformed host payload never fails the
//! host: the hook prints its neutral response and exits zero.

use std::path::Path;

use protocol::RequestMeta;
use serde_json::{Value, json};

const HOOK_BUDGET_MS: u64 = 190;

/// Clients with native CLI hooks.
pub fn supported_client(client: &str) -> bool {
    matches!(client, "codex" | "claude" | "antigravity")
}

/// Events that carry submitted user text and therefore attempt Recall.
pub fn is_prompt_event(event: &str) -> bool {
    matches!(event, "UserPromptSubmit" | "PreInvocation")
}

pub fn is_session_start(event: &str) -> bool {
    matches!(event, "SessionStart" | "SessionStartComplete")
}

/// Extract the submitted prompt from a tolerant set of host field shapes.
pub fn prompt_from(payload: &Value) -> Option<String> {
    for key in [
        "prompt",
        "userPrompt",
        "user_prompt",
        "message",
        "input",
        "text",
        "content",
    ] {
        match payload.get(key) {
            Some(Value::String(text)) if !text.trim().is_empty() => return Some(text.clone()),
            Some(Value::Object(object)) => {
                if let Some(Value::String(text)) = object.get("text")
                    && !text.trim().is_empty()
                {
                    return Some(text.clone());
                }
                if let Some(Value::Array(parts)) = object.get("content") {
                    let joined: Vec<&str> = parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect();
                    if !joined.is_empty() {
                        return Some(joined.join("\n"));
                    }
                }
            }
            _ => {}
        }
    }
    None
}

/// Repository identity for a hook payload.
///
/// A host-provided identity always wins. Otherwise the working directory the
/// host reports is resolved through the same canonicalisation the daemon uses
/// for capture (`git remote get-url origin`, then a stable local identity), so
/// prompt-time recall is scoped to the same repository the sessions were
/// captured under instead of falling back to global context only.
pub fn repository_from(payload: &Value) -> Option<String> {
    let explicit = payload
        .get("repository")
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .pointer("/workspace/repository")
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let cwd = payload
        .get("cwd")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/workspace/cwd").and_then(Value::as_str))
        .or_else(|| payload.pointer("/workspacePaths/0").and_then(Value::as_str))
        .or_else(|| {
            payload
                .pointer("/workspace/paths/0")
                .and_then(Value::as_str)
        });
    repository_identity::resolve_repository_identity(repository_identity::ResolveInput {
        cwd: cwd.map(Path::new),
        explicit: explicit.as_deref(),
        legacy: None,
        mappings: &[],
    })
}

/// Neutral response when no context can be produced.
pub fn neutral_response(client: &str, event: &str) -> Value {
    if client == "antigravity" && event == "Stop" {
        return json!({ "decision": "stop" });
    }
    json!({})
}

/// Run one hook. Returns the exact stdout payload plus a stderr diagnostic.
pub async fn run(
    client: &str,
    event: &str,
    socket: &Path,
    payload: Value,
) -> (Value, Option<String>) {
    if !supported_client(client) {
        return (
            neutral_response(client, event),
            Some(format!("lore hook: unknown client {client}")),
        );
    }
    let wants_recall = is_prompt_event(event) || is_session_start(event);
    if !wants_recall {
        return (neutral_response(client, event), None);
    }
    let Some(prompt) = prompt_from(&payload) else {
        return (neutral_response(client, event), None);
    };
    let repository = repository_from(&payload);
    let meta = RequestMeta {
        client_id: format!("hook.{client}"),
        request_id: format!("hook-{}-{}", std::process::id(), nanos()),
        session_id: payload
            .get("sessionId")
            .or_else(|| payload.get("session_id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        expected_store_id: None,
        timeout_ms: Some(HOOK_BUDGET_MS),
        required_capabilities: Vec::new(),
    };
    // Recall pins the store it reads, so the hook must negotiate the identity
    // first: without it every prompt-time recall is refused with
    // STORE_ID_REQUIRED and the host silently gets no context.
    let status_meta = RequestMeta {
        request_id: format!("hook-status-{}-{}", std::process::id(), nanos()),
        ..meta.clone()
    };
    let store_id = match lore::request(socket, "/v2/status", status_meta, json!({})).await {
        Ok(outcome) if outcome.is_success() => serde_json::from_str::<Value>(&outcome.body)
            .ok()
            .and_then(|body| {
                body.pointer("/storeId")
                    .or_else(|| body.pointer("/result/storeId"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
        Ok(_) => None,
        Err(_) => None,
    };
    let Some(store_id) = store_id else {
        return (
            neutral_response(client, event),
            Some("lore hook: daemon status unavailable".to_string()),
        );
    };
    let meta = RequestMeta {
        expected_store_id: Some(store_id),
        ..meta
    };

    let params = json!({
        "query": prompt.chars().take(16 * 1024).collect::<String>(),
        "repository": repository,
        "limit": 6
    });
    match lore::request(socket, "/v2/recall", meta, params).await {
        Ok(outcome) if outcome.is_success() => {
            let body: Value = match serde_json::from_str(&outcome.body) {
                Ok(value) => value,
                Err(_) => return (neutral_response(client, event), None),
            };
            let context = body
                .pointer("/result/context")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if context.is_empty() {
                return (neutral_response(client, event), None);
            }
            (json!({ "context": context }), None)
        }
        Ok(outcome) => (
            neutral_response(client, event),
            Some(format!(
                "lore hook: request failed with HTTP {}",
                outcome.status_code
            )),
        ),
        Err(error) => (
            neutral_response(client, event),
            Some(format!("lore hook: daemon unavailable: {error:#}")),
        ),
    }
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_are_extracted_from_host_shapes() {
        assert_eq!(
            prompt_from(&json!({"prompt": "fix the timeout"})).as_deref(),
            Some("fix the timeout")
        );
        assert_eq!(
            prompt_from(&json!({"message": {"content": [{"type": "text", "text": "hello"}]}}))
                .as_deref(),
            Some("hello")
        );
        assert_eq!(prompt_from(&json!({"other": 1})), None);
    }

    #[test]
    fn antigravity_stop_keeps_its_neutral_form() {
        assert_eq!(
            neutral_response("antigravity", "Stop"),
            json!({"decision": "stop"})
        );
        assert_eq!(neutral_response("codex", "Stop"), json!({}));
    }

    #[test]
    fn event_classification_is_explicit() {
        assert!(is_prompt_event("UserPromptSubmit"));
        assert!(is_session_start("SessionStart"));
        assert!(!is_prompt_event("PostToolUse"));
    }
}
