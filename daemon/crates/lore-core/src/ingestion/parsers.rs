//! Versioned transcript parsers behind one normalized-record interface.
//!
//! Every parser consumes complete text records and emits [`SourceRecord`]
//! evidence. Parsers never read files, never see unapproved paths and never
//! promote transcript text into memories; they only normalize.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::store::SourceRecord;

/// Parser version included in source identity and evidence revisions. Bump
/// when normalized output changes so affected sources are re-parsed.
pub const PARSER_VERSION: &str = "1";

/// One parser-state snapshot persisted with a checkpoint.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParserState {
    pub seq: i64,
    pub turn_index: i64,
    #[serde(default)]
    pub last_user_key: Option<String>,
    #[serde(default)]
    pub branch_leaf: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub nodes: BTreeMap<String, NodeState>,
    #[serde(default)]
    pub steps: BTreeMap<i64, StepState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeState {
    pub parent: Option<String>,
    pub order: i64,
    pub key: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepState {
    pub turn_index: i64,
    pub key: String,
}

/// One parsed record plus any retrospective completeness corrections.
#[derive(Debug, Clone, Default)]
pub struct LineParse {
    pub native_identity: Option<String>,
    pub records: Vec<SourceRecord>,
    /// Evidence keys whose completeness changed without a revision change.
    pub corrections: Vec<(String, String)>,
    /// Set when the record cannot be normalized; counts as a skipped record.
    pub skip: Option<&'static str>,
}

/// Bounded in-process parser for one source generation.
pub struct LineParser {
    client: String,
    pub state: ParserState,
    /// Fallback session identity for clients without a header identity.
    path_identity: String,
}

impl LineParser {
    pub fn new(client: &str, path_identity: &str, state: ParserState) -> Self {
        Self {
            client: client.to_string(),
            state,
            path_identity: path_identity.to_string(),
        }
    }

    pub fn native_identity(&self) -> String {
        self.path_identity.clone()
    }

    /// Session identity discovered from a header record, if the client has one.
    pub fn session_identity(&self) -> &str {
        self.path_identity.as_str()
    }

    pub fn set_session_identity(&mut self, identity: &str) {
        self.path_identity = identity.to_string();
    }

    /// Version of the parser that produced the current state.
    pub fn version(&self) -> &'static str {
        PARSER_VERSION
    }

    /// Parse one complete text record. The caller owns malformed-line
    /// accounting; a `skip` outcome means the record was well-formed JSON but
    /// carries no capturable evidence.
    pub fn parse(&mut self, line: &str) -> LineParse {        match self.client.as_str() {
            "pi" => self.parse_pi(line),
            "codex" => self.parse_codex(line),
            "claude" => self.parse_claude(line),
            "antigravity" => self.parse_antigravity(line),
            _ => LineParse {
                skip: Some("unsupported_client"),
                ..LineParse::default()
            },
        }
    }

    fn next_seq(&mut self) -> i64 {
        self.state.seq += 1;
        self.state.seq
    }

    fn evidence(&self, local: &str) -> String {
        format!("{}:{}:{}", self.client, self.path_identity, local)
    }

    fn parse_pi(&mut self, line: &str) -> LineParse {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return LineParse { skip: Some("malformed_record"), ..LineParse::default() };
        };
        let seq = self.next_seq();
        let mut out = LineParse::default();
        match value.get("type").and_then(|value| value.as_str()) {
            Some("session") => {
                if let Some(id) = value.get("id").and_then(|value| value.as_str()) {
                    out.native_identity = Some(id.to_string());
                    self.set_session_identity(id);
                }
                out.records.push(SourceRecord {
                    evidence_key: self.evidence(&format!("session:{seq}")),
                    kind: "session".into(),
                    role: None,
                    turn_index: None,
                    parent_key: None,
                    branch: None,
                    text: value.get("cwd").and_then(|value| value.as_str()).unwrap_or("").to_string(),
                    completeness: "complete".into(),
                    revision: 1,
                });
            }
            Some("compaction") => {
                let summary = value.get("summary").and_then(|value| value.as_str()).unwrap_or("");
                if !summary.trim().is_empty() {
                    out.records.push(SourceRecord {
                        evidence_key: self.evidence(&format!("compaction:{seq}")),
                        kind: "summary".into(),
                        role: Some("assistant".into()),
                        turn_index: Some(self.state.turn_index),
                        parent_key: self.state.last_user_key.clone(),
                        branch: None,
                        text: summary.to_string(),
                        completeness: "summary".into(),
                        revision: 1,
                    });
                }
            }
            Some("message") => {
                let message = value.get("message").cloned().unwrap_or_default();
                let role = message.get("role").and_then(|value| value.as_str()).unwrap_or("");
                let content = block_text(message.get("content"));
                match role {
                    "user" => {
                        if !content.trim().is_empty() {
                            self.state.turn_index += 1;
                            let key = self.evidence(&format!("user:{seq}"));
                            self.state.last_user_key = Some(key.clone());
                            out.records.push(SourceRecord {
                                evidence_key: key,
                                kind: "user_turn".into(),
                                role: Some("user".into()),
                                turn_index: Some(self.state.turn_index),
                                parent_key: None,
                                branch: None,
                                text: content,
                                completeness: "complete".into(),
                                revision: 1,
                            });
                        }
                    }
                    "assistant" => {
                        if !content.trim().is_empty() {
                            out.records.push(SourceRecord {
                                evidence_key: self.evidence(&format!("assistant:{seq}")),
                                kind: "assistant_turn".into(),
                                role: Some("assistant".into()),
                                turn_index: Some(self.state.turn_index),
                                parent_key: self.state.last_user_key.clone(),
                                branch: None,
                                text: content,
                                completeness: "complete".into(),
                                revision: 1,
                            });
                        }
                        for (index, tool) in tool_calls(message.get("content")).into_iter().enumerate() {
                            out.records.push(SourceRecord {
                                evidence_key: self.evidence(&format!("tool:{seq}:{index}")),
                                kind: "tool".into(),
                                role: Some("tool".into()),
                                turn_index: Some(self.state.turn_index),
                                parent_key: self.state.last_user_key.clone(),
                                branch: None,
                                text: tool,
                                completeness: "complete".into(),
                                revision: 1,
                            });
                        }
                    }
                    _ => {}
                }
            }
            _ => out.skip = Some("ignored_record"),
        }
        out
    }

    fn parse_codex(&mut self, line: &str) -> LineParse {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return LineParse { skip: Some("malformed_record"), ..LineParse::default() };
        };
        let seq = self.next_seq();
        let mut out = LineParse::default();
        match value.get("type").and_then(|value| value.as_str()) {
            Some("session_meta") => {
                if let Some(id) = value.pointer("/payload/id").and_then(|value| value.as_str()) {
                    out.native_identity = Some(id.to_string());
                    self.set_session_identity(id);
                }
                out.records.push(SourceRecord {
                    evidence_key: self.evidence(&format!("session:{seq}")),
                    kind: "session".into(),
                    role: None,
                    turn_index: None,
                    parent_key: None,
                    branch: None,
                    text: value.pointer("/payload/cwd").and_then(|value| value.as_str()).unwrap_or("").to_string(),
                    completeness: "complete".into(),
                    revision: 1,
                });
            }
            Some("response_item") => {
                let payload = value.get("payload").cloned().unwrap_or_default();
                if payload.get("type").and_then(|value| value.as_str()) != Some("message") {
                    out.skip = Some("ignored_record");
                    return out;
                }
                if payload.get("channel").and_then(|value| value.as_str()) == Some("analysis") {
                    out.skip = Some("ignored_record");
                    return out;
                }
                let role = payload.get("role").and_then(|value| value.as_str()).unwrap_or("");
                let content = block_text(payload.get("content"));
                if content.trim().is_empty() {
                    out.skip = Some("ignored_record");
                    return out;
                }
                match role {
                    "user" => {
                        self.state.turn_index += 1;
                        let key = self.evidence(&format!("user:{seq}"));
                        self.state.last_user_key = Some(key.clone());
                        out.records.push(SourceRecord {
                            evidence_key: key,
                            kind: "user_turn".into(),
                            role: Some("user".into()),
                            turn_index: Some(self.state.turn_index),
                            parent_key: None,
                            branch: None,
                            text: content,
                            completeness: "complete".into(),
                            revision: 1,
                        });
                    }
                    "assistant" => out.records.push(SourceRecord {
                        evidence_key: self.evidence(&format!("assistant:{seq}")),
                        kind: "assistant_turn".into(),
                        role: Some("assistant".into()),
                        turn_index: Some(self.state.turn_index),
                        parent_key: self.state.last_user_key.clone(),
                        branch: None,
                        text: content,
                        completeness: "complete".into(),
                        revision: 1,
                    }),
                    _ => out.skip = Some("ignored_record"),
                }
            }
            _ => out.skip = Some("ignored_record"),
        }
        out
    }

    fn parse_claude(&mut self, line: &str) -> LineParse {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return LineParse { skip: Some("malformed_record"), ..LineParse::default() };
        };
        let Some(uuid) = value.get("uuid").and_then(|value| value.as_str()) else {
            return LineParse { skip: Some("ignored_record"), ..LineParse::default() };
        };
        if value.get("isMeta").and_then(|value| value.as_bool()).unwrap_or(false) {
            return LineParse { skip: Some("ignored_record"), ..LineParse::default() };
        }
        let kind = value.get("type").and_then(|value| value.as_str()).unwrap_or("");
        if !matches!(kind, "user" | "assistant") {
            return LineParse { skip: Some("ignored_record"), ..LineParse::default() };
        }
        if let Some(session) = value.get("sessionId").and_then(|value| value.as_str()) {
            self.set_session_identity(session);
            let mut out = LineParse { native_identity: Some(session.to_string()), ..LineParse::default() };
            let parsed = self.parse_claude_node(&value, uuid, kind);
            out.records = parsed.records;
            out.corrections = parsed.corrections;
            out.skip = parsed.skip;
            return out;
        }
        self.parse_claude_node(&value, uuid, kind)
    }

    fn parse_claude_node(&mut self, value: &serde_json::Value, uuid: &str, kind: &str) -> LineParse {
        let seq = self.next_seq();
        let mut out = LineParse::default();
        let message = value.get("message").cloned().unwrap_or_default();
        let text = block_text(message.get("content"));
        if text.trim().is_empty() {
            out.skip = Some("ignored_record");
            return out;
        }
        let parent = value
            .get("parentUuid")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let order = self
            .state
            .nodes
            .get(uuid)
            .map(|node| node.order)
            .unwrap_or_else(|| {
                self.state
                    .nodes
                    .values()
                    .map(|node| node.order)
                    .max()
                    .unwrap_or(0)
                    + 1
            });
        let key = self.evidence(&format!("{kind}:{uuid}:{seq}"));
        let prior = self.state.nodes.get(uuid).cloned();
        if let Some(prior) = &prior
            && prior.key != key
        {
            out.corrections.push((prior.key.clone(), "abandoned".into()));
        }
        self.state.nodes.insert(
            uuid.to_string(),
            NodeState {
                parent: parent.clone(),
                order,
                key: key.clone(),
                active: true,
            },
        );
        self.state.branch_leaf = Some(uuid.to_string());
        self.rebuild_claude_branch(&mut out);
        out.records.push(SourceRecord {
            evidence_key: key.clone(),
            kind: if kind == "user" { "user_turn".into() } else { "assistant_turn".into() },
            role: Some(kind.to_string()),
            turn_index: Some(seq),
            parent_key: parent.map(|parent| format!("claude:{}:{}", self.path_identity, parent)),
            branch: Some(self.path_identity.clone()),
            text,
            completeness: "complete".into(),
            revision: 1,
        });
        out
    }

    /// Mark every node off the active parent chain as abandoned. Bounded by
    /// `MAX_BRANCH_NODES`; overflow leaves the oldest nodes unverified rather
    /// than guessing a chronology.
    fn rebuild_claude_branch(&mut self, out: &mut LineParse) {
        const MAX_BRANCH_NODES: usize = 4_096;
        let mut active = std::collections::HashSet::new();
        let mut cursor = self.state.branch_leaf.clone();
        let mut guard = 0usize;
        while let Some(uuid) = cursor {
            if !active.insert(uuid.clone()) || guard >= MAX_BRANCH_NODES {
                break;
            }
            guard += 1;
            cursor = self
                .state
                .nodes
                .get(&uuid)
                .and_then(|node| node.parent.clone());
        }
        let overflow = self.state.nodes.len() > MAX_BRANCH_NODES;
        for (uuid, node) in self.state.nodes.iter_mut() {
            let should_be_active = active.contains(uuid);
            if !should_be_active && node.active {
                node.active = false;
                out.corrections.push((node.key.clone(), "abandoned".into()));
            }
            if should_be_active {
                node.active = true;
            }
        }
        if overflow {
            out.skip = Some("branch_overflow");
        }
    }

    fn parse_antigravity(&mut self, line: &str) -> LineParse {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return LineParse { skip: Some("malformed_record"), ..LineParse::default() };
        };
        let Some(step_index) = value.get("step_index").and_then(|value| value.as_i64()) else {
            return LineParse { skip: Some("ignored_record"), ..LineParse::default() };
        };
        let source = value.get("source").and_then(|value| value.as_str()).unwrap_or("");
        let text = block_text(value.get("content"));
        if text.trim().is_empty() {
            return LineParse { skip: Some("ignored_record"), ..LineParse::default() };
        }
        let seq = self.next_seq();
        let mut out = LineParse::default();
        let role = if source == "USER" || source == "HUMAN" { "user" } else { "assistant" };
        if role == "user" {
            self.state.turn_index += 1;
            let key = self.evidence(&format!("user:{step_index}"));
            self.state.last_user_key = Some(key.clone());
            self.state.steps.insert(step_index, StepState { turn_index: self.state.turn_index, key: key.clone() });
            out.records.push(SourceRecord {
                evidence_key: key,
                kind: "user_turn".into(),
                role: Some("user".into()),
                turn_index: Some(self.state.turn_index),
                parent_key: None,
                branch: None,
                text,
                completeness: "complete".into(),
                revision: 1,
            });
        } else {
            let turn_index = self
                .state
                .steps
                .range(..step_index)
                .next_back()
                .map(|(_, step)| step.turn_index)
                .unwrap_or(self.state.turn_index);
            if let Some(prior) = self.state.steps.get(&step_index)
                && prior.turn_index == turn_index
            {
                // A revision of the same step replaces the prior evidence.
                out.corrections.push((prior.key.clone(), "abandoned".into()));
            }
            let key = self.evidence(&format!("assistant:{step_index}:{seq}"));
            self.state.steps.insert(step_index, StepState { turn_index, key: key.clone() });
            out.records.push(SourceRecord {
                evidence_key: key,
                kind: "assistant_turn".into(),
                role: Some("assistant".into()),
                turn_index: Some(turn_index),
                parent_key: self.state.last_user_key.clone(),
                branch: None,
                text,
                completeness: "complete".into(),
                revision: 1,
            });
        }
        out
    }
}

fn block_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(blocks)) => {
            let mut parts = Vec::new();
            for block in blocks {
                if let Some(text) = block.get("text").and_then(|value| value.as_str())
                    && block.get("type").and_then(|value| value.as_str()) != Some("toolCall")
                {
                    parts.push(text.to_string());
                } else if let Some(text) = block.get("content").and_then(|value| value.as_str()) {
                    parts.push(text.to_string());
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}

fn tool_calls(content: Option<&serde_json::Value>) -> Vec<String> {
    let Some(serde_json::Value::Array(blocks)) = content else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|block| block.get("type").and_then(|value| value.as_str()) == Some("toolCall"))
        .filter_map(|block| {
            let name = block.get("name").and_then(|value| value.as_str())?;
            if !matches!(name, "write" | "edit" | "read") {
                return None;
            }
            let arguments = block.get("arguments")?;
            let path = arguments
                .get("path")
                .or_else(|| arguments.get("filePath"))
                .and_then(|value| value.as_str())?;
            if path.trim().is_empty() {
                return None;
            }
            Some(format!("{name}: {path}"))
        })
        .collect()
}

/// Whether the first complete record identifies this client's format.
pub fn matches_client(client: &str, line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    match client {
        "pi" => value.get("type").and_then(|value| value.as_str()) == Some("session"),
        "codex" => value.get("type").and_then(|value| value.as_str()) == Some("session_meta"),
        "claude" => {
            value.get("sessionId").and_then(|value| value.as_str()).is_some()
                && matches!(value.get("type").and_then(|value| value.as_str()), Some("user") | Some("assistant"))
        }
        "antigravity" => value.get("step_index").and_then(|value| value.as_i64()).is_some(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pai_and_codex_headers_carry_identity() {
        let mut pi = LineParser::new("pi", "path", ParserState::default());
        let header = pi.parse(r#"{"type":"session","id":"pi-1","cwd":"/work"}"#);
        assert_eq!(header.native_identity.as_deref(), Some("pi-1"));
        let mut codex = LineParser::new("codex", "path", ParserState::default());
        let header = codex.parse(r#"{"type":"session_meta","payload":{"id":"cx-1"}}"#);
        assert_eq!(header.native_identity.as_deref(), Some("cx-1"));
    }

    #[test]
    fn client_matching_is_format_based() {
        assert!(matches_client("pi", r#"{"type":"session","id":"x"}"#));
        assert!(!matches_client("pi", r#"{"type":"session_meta","payload":{}}"#));
        assert!(matches_client("codex", r#"{"type":"session_meta","payload":{}}"#));
        assert!(matches_client("claude", r#"{"type":"user","sessionId":"s"}"#));
        assert!(matches_client("antigravity", r#"{"step_index":1}"#));
    }

    #[test]
    fn claude_branch_marks_off_chain_nodes_abandoned() {
        let mut parser = LineParser::new("claude", "s1", ParserState::default());
        parser.parse(r#"{"type":"user","uuid":"a","sessionId":"s1","message":{"content":"root"}}"#);
        parser.parse(r#"{"type":"assistant","uuid":"b","parentUuid":"a","message":{"content":"main"}}"#);
        // A sibling branch replaces the active leaf; the main chain stays active.
        let sibling = parser.parse(
            r#"{"type":"assistant","uuid":"c","parentUuid":"a","message":{"content":"side"}}"#,
        );
        let _ = sibling;
        let back = parser.parse(
            r#"{"type":"assistant","uuid":"d","parentUuid":"b","message":{"content":"back on chain"}}"#,
        );
        assert!(back.corrections.iter().any(|(_, completeness)| completeness == "abandoned"));
        assert!(parser.state.nodes["b"].active, "the main chain stays active");
        assert!(!parser.state.nodes["c"].active, "the side branch is abandoned");
        assert!(parser.state.nodes["d"].active, "the returning node is active");
    }

    #[test]
    fn antigravity_maps_steps_to_turns() {
        let mut parser = LineParser::new("antigravity", "export", ParserState::default());
        parser.parse(r#"{"step_index":1,"type":"USER_INPUT","source":"USER","content":"hello"}"#);
        let reply =
            parser.parse(r#"{"step_index":2,"type":"PLANNER_RESPONSE","source":"MODEL","content":"hi"}"#);
        assert_eq!(reply.records[0].turn_index, Some(1));
        assert_eq!(reply.records[0].kind, "assistant_turn");
    }
}
