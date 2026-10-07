//! Wire types for the Lore v2 HTTP/JSON contract.
//!
//! The JSON Schema documents under `schemas/v2/` are the language-independent
//! contract. These types must serialize to the same field names; the
//! `status_response_matches_schema` test enforces that for the G1 proof.

use serde::{Deserialize, Serialize};

/// Wire API major version. Carried in the route path and in Status.
pub const API_MAJOR: u16 = 2;
/// Wire API minor version.
pub const API_MINOR: u16 = 0;
/// Fixed Host header value required on every request.
pub const HOST: &str = "lore.local";
/// Hard cap for a fully encoded request body (contract: 1 MiB).
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
/// Largest integer that round-trips through IEEE-754 doubles (2^53 - 1).
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
/// Server clamp for caller-supplied operation deadlines.
pub const MAX_TIMEOUT_MS: u64 = 5_000;
/// Header/body receive deadline, independent of operation execution.
pub const BODY_DEADLINE_MS: u64 = 1_000;
/// Default concurrent in-flight request limit.
pub const MAX_INFLIGHT_DEFAULT: usize = 64;

/// Stable error codes. Clients branch on these, never on message text.
pub mod code {
    pub const INVALID_ARGUMENT: &str = "INVALID_ARGUMENT";
    pub const UNIMPLEMENTED: &str = "UNIMPLEMENTED";
    pub const FAILED_PRECONDITION: &str = "FAILED_PRECONDITION";
    pub const RESOURCE_EXHAUSTED: &str = "RESOURCE_EXHAUSTED";
    pub const DEADLINE_EXCEEDED: &str = "DEADLINE_EXCEEDED";
    pub const INTERNAL: &str = "INTERNAL";
}

/// Stable error reasons for the G1 proof surface.
pub mod reason {
    pub const INVALID_JSON: &str = "INVALID_JSON";
    pub const INVALID_DEADLINE: &str = "INVALID_DEADLINE";
    pub const INVALID_HOST: &str = "INVALID_HOST";
    pub const METHOD_NOT_ALLOWED: &str = "METHOD_NOT_ALLOWED";
    pub const UNSUPPORTED_MEDIA_TYPE: &str = "UNSUPPORTED_MEDIA_TYPE";
    pub const ROUTE_UNIMPLEMENTED: &str = "ROUTE_UNIMPLEMENTED";
    pub const REQUEST_BYTES: &str = "REQUEST_BYTES";
    pub const REQUEST_DEADLINE: &str = "REQUEST_DEADLINE";
    pub const REQUEST_TIMEOUT: &str = "REQUEST_TIMEOUT";
    pub const REQUEST_CAPACITY: &str = "REQUEST_CAPACITY";
    pub const UNSAFE_INTEGER: &str = "UNSAFE_INTEGER";
    pub const INTERNAL_FAILURE: &str = "INTERNAL_FAILURE";
    pub const API_MAJOR_MISMATCH: &str = "API_MAJOR_MISMATCH";
    pub const STORE_MISMATCH: &str = "STORE_MISMATCH";
}

/// Per-request metadata every route accepts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestMeta {
    /// Stable client identity (`cli`, `pi`, `test.<name>`, ...).
    pub client_id: String,
    /// Unique diagnostic identifier.
    pub request_id: String,
    /// Host session identifier, when the client has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Store the client believes it is talking to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_store_id: Option<String>,
    /// Remaining caller budget in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// Capabilities the caller requires.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_capabilities: Vec<String>,
}

/// Versioned request envelope. Unknown top-level fields are rejected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope<P> {
    pub meta: RequestMeta,
    #[serde(default)]
    pub params: P,
}

/// Successful response envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OkEnvelope<T> {
    pub ok: bool,
    pub request_id: String,
    pub store_id: String,
    pub result: T,
}

/// Structured, safe error summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    pub code: String,
    pub reason: String,
    pub retryable: bool,
    pub message: String,
}

/// Error response envelope. Identifiers are present when known.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEnvelope {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_id: Option<String>,
    pub error: ErrorDetail,
}

/// `/v2/status` parameters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusParams {
    /// Optional check that the caller understands the served major version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_api_major: Option<u16>,
}

/// Coarse readiness signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Readiness {
    Ready,
    Degraded,
    Unavailable,
}

/// Memory scope on the wire.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Global,
    Repo,
    Transferable,
}

/// `/v2/retain` parameters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainParams {
    pub idempotency_key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub content: String,
    pub scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
}

/// `/v2/retain` result. 64-bit counters are decimal strings on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainResult {
    pub memory_id: String,
    pub committed_revision: String,
    pub write_result: String,
    pub embedding_status: String,
}

/// `/v2/forget` parameters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForgetParams {
    pub idempotency_key: String,
    pub memory_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `/v2/forget` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetResult {
    pub memory_id: String,
    pub committed_revision: String,
    pub write_result: String,
}

/// Embedding provider and coverage state reported by Status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub state: String,
    pub dimensions: u64,
    pub coverage_current: String,
    pub coverage_eligible: String,
    pub pending: String,
    pub failed: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_pending_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// `/v2/jobs/status` parameters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobsStatusParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// One job row on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub job_id: String,
    pub memory_id: String,
    pub state: String,
    pub attempts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_attempt_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
}

/// `/v2/jobs/status` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsStatusResult {
    pub jobs: Vec<JobRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub counts: JobCounts,
}

/// Queue counts by state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCounts {
    pub queued: String,
    pub running: String,
    pub retry_wait: String,
    pub failed: String,
}

/// `/v2/jobs/retry` parameters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobsRetryParams {
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memory_ids: Vec<String>,
}

/// `/v2/jobs/retry` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsRetryResult {
    pub reset: u64,
}

/// `/v2/config/reload` parameters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigReloadParams {
    pub idempotency_key: String,
}

/// `/v2/config/reload` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReloadResult {
    pub reloaded: bool,
    pub generation: u32,
    pub reason: String,
}

/// `/v2/sources/register` parameters. The path is optional for source stores
/// that are opened in place; a native session identity is required for
/// clients that expose one.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRegisterParams {
    pub idempotency_key: String,
    pub client: String,
    pub root_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// `/v2/sources/register` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRegisterResult {
    pub source_id: String,
    pub state: String,
    pub accepted: bool,
    pub coalesced: bool,
    pub generation: String,
}

/// `/v2/sources/hint` parameters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceHintParams {
    pub idempotency_key: String,
    pub source_id: String,
    pub event_id: String,
    /// `append`, `session-end` or `compaction`.
    pub event: String,
}

/// `/v2/sources/hint` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHintResult {
    pub source_id: String,
    pub state: String,
    pub accepted: bool,
    pub coalesced: bool,
}

/// `/v2/sources/status` parameters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceStatusParams {
    #[serde(default = "default_source_page")]
    pub limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Explicit local diagnostic: include raw paths. Defaults to off.
    #[serde(default)]
    pub include_paths: bool,
}

fn default_source_page() -> u32 {
    100
}

/// One source in `/v2/sources/status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatusRecord {
    pub source_id: String,
    pub client: String,
    pub root_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub repository_verified: bool,
    pub state: String,
    pub generation: String,
    pub generation_seq: i64,
    pub observed_size: i64,
    pub offset: i64,
    pub pending_bytes: i64,
    pub capture_revision: i64,
    pub normalized_records: i64,
    pub skipped_records: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_progress_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// `/v2/sources/status` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatusResult {
    pub sources: Vec<SourceStatusRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub observed_at: i64,
    pub counts: SourceStatusCounts,
    pub pending_extraction: i64,
}

/// Rehearsed state counters, reconciled at `observedAt`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatusCounts {
    pub discovered: i64,
    pub caught_up: i64,
    pub growing: i64,
    pub unavailable: i64,
    pub ambiguous: i64,
    pub failed: i64,
    pub skipped: i64,
}

/// `/v2/recall` parameters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecallParams {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default)]
    pub include_other_repositories: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_bytes: Option<u32>,
}

/// One complete structured memory record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub content: String,
    pub scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub authority: String,
    pub confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
}

/// One ordered rendered section.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallSection {
    pub id: String,
    pub memory_ids: Vec<String>,
    pub text: String,
    pub omitted: u64,
}

/// Bounded, content-free recall diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallDiagnostics {
    pub retrieval_mode: String,
    pub cache: String,
    pub vector_contribution: u64,
    pub candidate_pool_limit: u64,
    pub candidate_pool_truncated: bool,
    pub fallback_reason: String,
    pub response_bytes: u64,
    pub omitted_count: u64,
}

/// `/v2/recall` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallResult {
    pub records: Vec<MemoryRecord>,
    pub context: String,
    pub sections: Vec<RecallSection>,
    pub memory_revision: String,
    pub evaluated_at_ms: i64,
    pub derived_generation: String,
    pub diagnostics: RecallDiagnostics,
}

/// Maintained store counters reported by Status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCounts {
    pub active_memories: String,
    pub forgotten_memories: String,
    pub receipts: String,
}

/// In-flight work reported by Status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusQueue {
    pub queued: String,
    pub running: String,
}

/// `/v2/status` result. G1 proof fields plus stage-2 counters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub api_major: u16,
    pub api_minor: u16,
    pub daemon_version: String,
    pub schema_version: u32,
    pub store_id: String,
    pub process_instance_id: String,
    pub uptime_ms: u64,
    pub readiness: Readiness,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub capabilities: Vec<String>,
    pub memory_revision: String,
    pub derived_generation: String,
    pub counts: StatusCounts,
    pub queue: StatusQueue,
    pub embedding: EmbeddingStatus,
    pub sources: SourceStatusCounts,
}

/// Reject integers that cannot round-trip through a JavaScript number.
pub fn has_unsafe_integer(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Number(number) => {
            if let Some(unsigned) = number.as_u64() {
                unsigned > MAX_SAFE_INTEGER as u64
            } else if let Some(signed) = number.as_i64() {
                signed < -MAX_SAFE_INTEGER
            } else {
                number
                    .as_f64()
                    .is_none_or(|float| !float.is_finite() || float.abs() > MAX_SAFE_INTEGER as f64)
            }
        }
        serde_json::Value::Array(items) => items.iter().any(has_unsafe_integer),
        serde_json::Value::Object(map) => map.values().any(has_unsafe_integer),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn required(schema: &Value, pointer: &str) -> Vec<String> {
        let node = if pointer.is_empty() {
            schema
        } else {
            schema.pointer(pointer).expect("schema pointer exists")
        };
        let mut keys: Vec<String> = node
            .get("required")
            .and_then(Value::as_array)
            .expect("required array")
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .expect("required entries are strings")
                    .to_string()
            })
            .collect();
        keys.sort();
        keys
    }

    fn keys(value: &Value) -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
        keys.sort();
        keys
    }

    fn sample_status() -> StatusResult {
        StatusResult {
            api_major: API_MAJOR,
            api_minor: API_MINOR,
            daemon_version: "0.1.0".to_string(),
            schema_version: 1,            store_id: "store-test".to_string(),
            process_instance_id: "1-2".to_string(),
            uptime_ms: 0,
            readiness: Readiness::Ready,
            reason: None,
            capabilities: vec!["status.basic".to_string()],
            memory_revision: "0".to_string(),
            derived_generation: "0".to_string(),
            counts: StatusCounts {
                active_memories: "0".to_string(),
                forgotten_memories: "0".to_string(),
                receipts: "0".to_string(),
            },
            queue: StatusQueue {
                queued: "0".to_string(),
                running: "0".to_string(),
            },
            embedding: EmbeddingStatus {
                provider: None,
                state: "disabled".to_string(),
                dimensions: 0,
                coverage_current: "0".to_string(),
                coverage_eligible: "0".to_string(),
                pending: "0".to_string(),
                failed: "0".to_string(),
                oldest_pending_ms: None,
                last_error: None,
            },
            sources: SourceStatusCounts {
                discovered: 0,
                caught_up: 0,
                growing: 0,
                unavailable: 0,
                ambiguous: 0,
                failed: 0,
                skipped: 0,
            },
        }
    }

    #[test]
    fn status_response_matches_schema() {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../schemas/v2/status.response.schema.json"
        ))
        .expect("status response schema parses");
        let envelope = OkEnvelope {
            ok: true,
            request_id: "request-1".to_string(),
            store_id: "store-test".to_string(),
            result: sample_status(),
        };
        let value = serde_json::to_value(&envelope).expect("serializes");

        assert_eq!(
            required(&schema, ""),
            keys(&value),
            "envelope required fields"
        );
        assert_eq!(
            required(&schema, "/properties/result"),
            keys(&value["result"]),
            "result required fields"
        );
    }

    #[test]
    fn error_response_matches_schema() {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../schemas/v2/error.response.schema.json"
        ))
        .expect("error response schema parses");
        let envelope = ErrorEnvelope {
            ok: false,
            request_id: None,
            store_id: None,
            error: ErrorDetail {
                code: code::INVALID_ARGUMENT.to_string(),
                reason: reason::INVALID_JSON.to_string(),
                retryable: false,
                message: "request rejected".to_string(),
            },
        };
        let value = serde_json::to_value(&envelope).expect("serializes");
        assert_eq!(
            required(&schema, ""),
            keys(&value),
            "error envelope required fields"
        );
        assert_eq!(
            required(&schema, "/$defs/error"),
            keys(&value["error"]),
            "error detail required fields"
        );
    }

    #[test]
    fn status_request_rejects_unknown_fields() {
        let raw = r#"{"meta":{"clientId":"cli","requestId":"r"},"params":{},"extra":true}"#;
        assert!(serde_json::from_str::<Envelope<StatusParams>>(raw).is_err());
    }

    #[test]
    fn unsafe_integers_are_detected_at_any_depth() {
        let body: serde_json::Value = serde_json::from_str(
            r#"{"meta":{"timeoutMs":9007199254740993},"list":[1,2,{"deep":-9007199254740994}]}"#,
        )
        .expect("parses");
        assert!(has_unsafe_integer(&body));

        let safe: serde_json::Value =
            serde_json::from_str(r#"{"timeoutMs":9007199254740991,"ratio":1.5}"#).expect("parses");
        assert!(!has_unsafe_integer(&safe));
    }

    #[test]
    fn duplicate_object_keys_are_rejected() {
        let raw = r#"{"meta":{"clientId":"cli","clientId":"cli","requestId":"r"}}"#;
        let error = serde_json::from_str::<Envelope<StatusParams>>(raw).expect_err("duplicate key");
        assert!(
            error.to_string().contains("duplicate field"),
            "unexpected: {error}"
        );
    }

    #[test]
    fn nested_values_beyond_the_parser_limit_are_rejected() {
        let deep = format!("{}1{}", "[".repeat(300), "]".repeat(300));
        assert!(serde_json::from_str::<serde_json::Value>(&deep).is_err());
    }

    #[test]
    fn nan_and_infinity_are_not_valid_json() {
        assert!(serde_json::from_str::<serde_json::Value>("NaN").is_err());
        assert!(serde_json::from_str::<serde_json::Value>("Infinity").is_err());
    }

    #[test]
    fn additive_response_fields_are_ignored() {
        let raw = r#"{"ok":true,"requestId":"r","storeId":"s","futureField":{"a":1},"result":{"apiMajor":2,"apiMinor":0,"daemonVersion":"0.1.0","schemaVersion":1,"storeId":"s","processInstanceId":"p","uptimeMs":0,"readiness":"ready","capabilities":["status.basic"],"memoryRevision":"0","derivedGeneration":"0","counts":{"activeMemories":"0","forgottenMemories":"0","receipts":"0"},"queue":{"queued":"0","running":"0"},"embedding":{"state":"disabled","dimensions":0,"coverageCurrent":"0","coverageEligible":"0","pending":"0","failed":"0"},"sources":{"discovered":0,"caughtUp":0,"growing":0,"unavailable":0,"ambiguous":0,"failed":0,"skipped":0},"extra":true}}"#;
        let parsed: OkEnvelope<StatusResult> =
            serde_json::from_str(raw).expect("additive response fields are ignored");
        assert_eq!(parsed.result.api_major, 2);
        assert_eq!(parsed.store_id, "s");
    }

    #[test]
    fn envelope_uses_camel_case() {
        let meta = RequestMeta {
            client_id: "cli".to_string(),
            request_id: "request-1".to_string(),
            session_id: None,
            expected_store_id: Some("store-test".to_string()),
            timeout_ms: Some(160),
            required_capabilities: vec!["status.basic".to_string()],
        };
        let value = serde_json::to_value(&meta).expect("serializes");
        assert_eq!(value["clientId"], "cli");
        assert_eq!(value["expectedStoreId"], "store-test");
        assert_eq!(value["timeoutMs"], 160);
        assert!(
            value.get("sessionId").is_none(),
            "unset optional fields are omitted"
        );
    }

    fn parse(json: &str) -> Value {
        serde_json::from_str(json).expect("json parses")
    }

    fn resolve<'a>(schema: &'a Value, node: &'a Value) -> &'a Value {
        if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
            let pointer = reference.strip_prefix('#').unwrap_or(reference);
            return schema
                .pointer(pointer)
                .unwrap_or_else(|| panic!("unresolved $ref {reference}"));
        }
        node
    }

    /// Validate a fixture against a schema: required fields present, declared
    /// fields only, recursively through objects and array items.
    fn validate_node(schema: &Value, node: &Value, value: &Value, path: &str) {
        let node = resolve(schema, node);
        if let Some(required) = node.get("required").and_then(Value::as_array) {
            let object = value
                .as_object()
                .unwrap_or_else(|| panic!("{path}: expected an object"));
            for field in required {
                let field = field.as_str().expect("required entries are strings");
                assert!(
                    object.contains_key(field),
                    "{path}: missing required {field}"
                );
            }
        }
        if let (Some(properties), Value::Object(map)) =
            (node.get("properties").and_then(Value::as_object), value)
        {
            for (key, child) in map {
                match properties.get(key) {
                    Some(property) => {
                        validate_node(schema, property, child, &format!("{path}.{key}"))
                    }
                    None => panic!("{path}: undeclared field {key}"),
                }
            }
        }
        if let (Some(items), Value::Array(entries)) = (node.get("items"), value) {
            for (index, entry) in entries.iter().enumerate() {
                validate_node(schema, items, entry, &format!("{path}[{index}]"));
            }
        }
    }

    #[test]
    fn request_fixtures_parse_into_typed_envelopes() {
        let status: Envelope<StatusParams> = serde_json::from_str(include_str!(
            "../../../../tests/v2/fixtures/status.request.json"
        ))
        .expect("status fixture");
        assert_eq!(status.meta.client_id, "fixture");

        let retain: Envelope<RetainParams> = serde_json::from_str(include_str!(
            "../../../../tests/v2/fixtures/retain.request.json"
        ))
        .expect("retain fixture");
        assert_eq!(retain.params.scope, Scope::Global);
        assert_eq!(retain.params.tags.len(), 2);

        let forget: Envelope<ForgetParams> = serde_json::from_str(include_str!(
            "../../../../tests/v2/fixtures/forget.request.json"
        ))
        .expect("forget fixture");
        assert_eq!(forget.params.memory_id.len(), 36);

        let recall: Envelope<RecallParams> = serde_json::from_str(include_str!(
            "../../../../tests/v2/fixtures/recall.request.json"
        ))
        .expect("recall fixture");
        assert_eq!(recall.params.limit, Some(6));
        assert!(!recall.params.include_other_repositories);
    }

    #[test]
    fn fixtures_match_their_schemas() {
        let cases: [(&str, &str, &str, &str); 8] = [
            (
                "status",
                include_str!("../../../../schemas/v2/status.request.schema.json"),
                "fixture",
                include_str!("../../../../tests/v2/fixtures/status.request.json"),
            ),
            (
                "retain",
                include_str!("../../../../schemas/v2/retain.request.schema.json"),
                "fixture",
                include_str!("../../../../tests/v2/fixtures/retain.request.json"),
            ),
            (
                "forget",
                include_str!("../../../../schemas/v2/forget.request.schema.json"),
                "fixture",
                include_str!("../../../../tests/v2/fixtures/forget.request.json"),
            ),
            (
                "recall",
                include_str!("../../../../schemas/v2/recall.request.schema.json"),
                "fixture",
                include_str!("../../../../tests/v2/fixtures/recall.request.json"),
            ),
            (
                "status",
                include_str!("../../../../schemas/v2/status.response.schema.json"),
                "fixture",
                include_str!("../../../../tests/v2/fixtures/status.response.json"),
            ),
            (
                "retain",
                include_str!("../../../../schemas/v2/retain.response.schema.json"),
                "fixture",
                include_str!("../../../../tests/v2/fixtures/retain.response.json"),
            ),
            (
                "forget",
                include_str!("../../../../schemas/v2/forget.response.schema.json"),
                "fixture",
                include_str!("../../../../tests/v2/fixtures/forget.response.json"),
            ),
            (
                "recall",
                include_str!("../../../../schemas/v2/recall.response.schema.json"),
                "fixture",
                include_str!("../../../../tests/v2/fixtures/recall.response.json"),
            ),
        ];
        for (name, schema, fixture_name, fixture) in cases {
            let schema = parse(schema);
            let fixture = parse(fixture);
            validate_node(
                &schema,
                &schema,
                &fixture,
                &format!("{name}:{fixture_name}"),
            );
        }
    }
}
