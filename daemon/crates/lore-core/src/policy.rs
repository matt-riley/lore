//! Stage-2 policy: payload validation, scope rules and canonical hashing.

use protocol::{MAX_SAFE_INTEGER, RecallParams, RetainParams, Scope};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::config::Limits;
use crate::error::{CoreError, CoreResult};

/// Validate a Retain payload before it reaches storage.
pub fn validate_retain(params: &RetainParams, limits: &Limits) -> CoreResult<()> {
    validate_idempotency_key(&params.idempotency_key)?;
    if params.kind.is_empty() || params.kind.len() > 64 {
        return Err(CoreError::invalid(
            "INVALID_TYPE",
            "type must be 1-64 bytes",
        ));
    }
    if params.content.is_empty() {
        return Err(CoreError::invalid(
            "INVALID_CONTENT",
            "content must not be empty",
        ));
    }
    if params.content.len() > limits.max_content_bytes {
        return Err(CoreError::invalid(
            "CONTENT_TOO_LARGE",
            format!("content exceeds {} bytes", limits.max_content_bytes),
        ));
    }
    validate_scope(params.scope, params.repository.as_deref())?;
    if let Some(confidence) = params.confidence
        && (!confidence.is_finite() || !(0.0..=1.0).contains(&confidence))
    {
        return Err(CoreError::invalid(
            "INVALID_CONFIDENCE",
            "confidence must be finite and within 0-1",
        ));
    }
    if let Some(expires) = params.expires_at_ms
        && expires.unsigned_abs() > MAX_SAFE_INTEGER as u64
    {
        return Err(CoreError::invalid(
            "UNSAFE_INTEGER",
            "expiresAtMs is outside the safe integer range",
        ));
    }
    if params.tags.len() > limits.max_tags {
        return Err(CoreError::invalid(
            "TOO_MANY_TAGS",
            format!("at most {} tags are allowed", limits.max_tags),
        ));
    }
    for tag in &params.tags {
        if tag.trim().is_empty() || tag.len() > limits.max_tag_bytes {
            return Err(CoreError::invalid(
                "INVALID_TAG",
                format!("tags must be 1-{} bytes", limits.max_tag_bytes),
            ));
        }
    }
    if let Some(session) = &params.source_session_id
        && session.len() > 256
    {
        return Err(CoreError::invalid(
            "INVALID_SESSION_ID",
            "sourceSessionId must be at most 256 bytes",
        ));
    }
    Ok(())
}

/// Validate a Forget payload.
pub fn validate_forget(reason: Option<&str>) -> CoreResult<()> {
    if let Some(reason) = reason
        && reason.len() > 512
    {
        return Err(CoreError::invalid(
            "INVALID_REASON",
            "reason must be at most 512 bytes",
        ));
    }
    Ok(())
}

/// Validate a Recall payload and resolve its effective budgets.
pub fn resolve_recall(params: &RecallParams, limits: &Limits) -> CoreResult<(u32, u32)> {
    if params.query.len() > limits.max_query_bytes {
        return Err(CoreError::invalid(
            "QUERY_TOO_LARGE",
            format!("query exceeds {} bytes", limits.max_query_bytes),
        ));
    }
    let limit = params.limit.unwrap_or(limits.default_results);
    if limit == 0 || limit > limits.max_results {
        return Err(CoreError::invalid(
            "INVALID_LIMIT",
            format!("limit must be 1-{}", limits.max_results),
        ));
    }
    let context_bytes = params.context_bytes.unwrap_or(limits.default_context_bytes);
    if context_bytes == 0 || context_bytes > limits.max_context_bytes {
        return Err(CoreError::invalid(
            "INVALID_CONTEXT_BYTES",
            format!("contextBytes must be 1-{}", limits.max_context_bytes),
        ));
    }
    Ok((limit, context_bytes))
}

fn validate_idempotency_key(key: &str) -> CoreResult<()> {
    if key.is_empty() || key.len() > 128 || !key.is_ascii() {
        return Err(CoreError::invalid(
            "INVALID_IDEMPOTENCY_KEY",
            "idempotencyKey must be 1-128 ASCII bytes",
        ));
    }
    Ok(())
}

/// Scope and repository must agree.
pub fn validate_scope(scope: Scope, repository: Option<&str>) -> CoreResult<()> {
    match scope {
        Scope::Global => {
            if repository.is_some() {
                return Err(CoreError::invalid(
                    "INVALID_SCOPE",
                    "global scope requires a null repository",
                ));
            }
        }
        Scope::Repo | Scope::Transferable => {
            let repository = repository.unwrap_or_default();
            if repository.is_empty() || repository.len() > 1024 {
                return Err(CoreError::invalid(
                    "INVALID_REPOSITORY",
                    "repo and transferable scope require a repository of 1-1024 bytes",
                ));
            }
        }
    }
    Ok(())
}

/// Render a scope for hashing and SQL.
pub fn scope_str(scope: Scope) -> &'static str {
    match scope {
        Scope::Global => "global",
        Scope::Repo => "repo",
        Scope::Transferable => "transferable",
    }
}

/// Deterministic canonical payload hash for Retain retries.
pub fn retain_request_hash(params: &RetainParams) -> String {
    let mut map = Map::new();
    map.insert("type".to_string(), json!(params.kind));
    map.insert("content".to_string(), json!(params.content));
    map.insert("scope".to_string(), json!(scope_str(params.scope)));
    map.insert("repository".to_string(), json!(params.repository));
    map.insert(
        "confidence".to_string(),
        json!(params.confidence.unwrap_or(1.0)),
    );
    map.insert("expiresAtMs".to_string(), json!(params.expires_at_ms));
    let mut tags: Vec<String> = params
        .tags
        .iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect();
    tags.sort();
    tags.dedup();
    map.insert("tags".to_string(), json!(tags));
    map.insert(
        "sourceSessionId".to_string(),
        json!(params.source_session_id),
    );
    sha256_hex(&serde_json::to_vec(&Value::Object(map)).unwrap_or_default())
}

/// Deterministic canonical payload hash for Forget retries.
pub fn forget_request_hash(memory_id: &str, reason: Option<&str>) -> String {
    let mut map = Map::new();
    map.insert("memoryId".to_string(), json!(memory_id));
    map.insert("reason".to_string(), json!(reason));
    sha256_hex(&serde_json::to_vec(&Value::Object(map)).unwrap_or_default())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}
