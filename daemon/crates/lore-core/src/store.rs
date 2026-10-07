//! Authoritative SQLite storage for the stage-2 store.
//!
//! One writer connection and four bounded read workers. Every authoritative
//! transaction commits memory, FTS, intent, revision, counters and receipt
//! together, so an acknowledgement survives process failure.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use protocol::{
    ForgetParams, ForgetResult, MAX_BODY_BYTES, MemoryRecord, RecallDiagnostics, RecallParams,
    RecallResult, RecallSection, RetainParams, RetainResult, Scope,
};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params, params_from_iter};
use uuid::Uuid;

use crate::config::{Limits, ResolvedConfig, STORE_SCHEMA_VERSION};
use crate::error::{CoreError, CoreResult};
use crate::policy;
use crate::retrieval;

mod embedding;
mod extraction;
mod migration;
mod source;
pub use embedding::{
    ClaimedJob, CompleteOutcome, EmbeddingCounts, FailOutcome, JobView, ReconcilePage,
    StoredVector, blob_to_vector, jittered_backoff_ms, vector_norm,
};
pub use source::{
    CaptureCommit, CaptureOutcome, SourceFilter, SourceRecord, SourceRootRow, SourceRow,
    content_hash, open_readonly, source_id_for,
};

const RECEIPT_OP_RETAIN: &str = "retain";
const RECEIPT_OP_FORGET: &str = "forget";
/// Leave headroom for the envelope around a recall result.
const RESPONSE_HEADROOM: usize = 4 * 1024;
/// Maximum eligible vectors scored per recall (configuration-storage cap).
const MAX_VECTOR_SCAN: usize = 10_000;
/// Stored-vector page size.
const VECTOR_PAGE: usize = 128;
/// Reciprocal-rank-fusion constant retained for documentation; the current
/// merge keeps semantic precedence as recorded in the G3 calibration report.
#[allow(dead_code)]
const RRF_K: f64 = 60.0;

const SCHEMA_V1_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS store_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    store_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    memory_revision INTEGER NOT NULL,
    derived_generation INTEGER NOT NULL,
    active_memories INTEGER NOT NULL,
    forgotten_memories INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'repo', 'transferable')),
    repository TEXT,
    authority TEXT NOT NULL,
    confidence REAL NOT NULL,
    tags_json TEXT NOT NULL,
    source_session_id TEXT,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    revision INTEGER NOT NULL,
    superseded_by TEXT,
    forgotten INTEGER NOT NULL DEFAULT 0,
    CHECK ((scope = 'global' AND repository IS NULL) OR (scope <> 'global' AND repository IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope, repository, forgotten, superseded_by);
CREATE INDEX IF NOT EXISTS idx_memories_expiry ON memories (expires_at_ms, forgotten);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, kind, tags, memory_id UNINDEXED, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS suppressions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT,
    scope TEXT,
    repository TEXT,
    fingerprint TEXT NOT NULL,
    reason TEXT,
    revision INTEGER NOT NULL,
    created_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_suppressions_memory ON suppressions (memory_id);
CREATE INDEX IF NOT EXISTS idx_suppressions_fingerprint ON suppressions (scope, repository, fingerprint);
CREATE TABLE IF NOT EXISTS idempotency_receipts (
    client_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (client_id, operation, idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS embedding_intents (
    memory_id TEXT PRIMARY KEY REFERENCES memories (id) ON DELETE CASCADE,
    desired_revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER,
    terminal_reason TEXT
) STRICT;
"#;

/// Forward migration 1 -> 2: embedding intents gain identity columns,
/// materialized jobs and stored vectors arrive.
const MIGRATION_2_SQL: &str = r#"
ALTER TABLE store_metadata ADD COLUMN provider_identity TEXT;
ALTER TABLE store_metadata ADD COLUMN reconciliation_cursor TEXT;
ALTER TABLE embedding_intents ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE embedding_intents ADD COLUMN model_identity TEXT NOT NULL DEFAULT '';
ALTER TABLE embedding_intents ADD COLUMN updated_ms INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS embedding_jobs (
    job_id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    target_revision INTEGER NOT NULL,
    target_hash TEXT NOT NULL,
    model_identity TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER,
    lease_token TEXT,
    lease_owner TEXT,
    lease_expires_ms INTEGER,
    terminal_reason TEXT,
    updated_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_state ON embedding_jobs (state, next_attempt_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_jobs_target ON embedding_jobs (memory_id, model_identity)
    WHERE state IN ('queued', 'running', 'retry_wait');
CREATE TABLE IF NOT EXISTS memory_vectors (
    memory_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    model_identity TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    norm REAL NOT NULL,
    vector BLOB NOT NULL,
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (memory_id, model_identity)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_memory_vectors_identity ON memory_vectors (model_identity, memory_id);
"#;

/// Forward migration 2 -> 3: approved source roots, captured sources,
/// normalized evidence, generation dispositions and extraction intent.
const MIGRATION_3_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS source_roots (
    root_id TEXT PRIMARY KEY,
    client TEXT NOT NULL,
    path TEXT NOT NULL,
    repository TEXT,
    cursor TEXT,
    complete INTEGER NOT NULL DEFAULT 0,
    observed_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sources (
    source_id TEXT PRIMARY KEY,
    client TEXT NOT NULL,
    root_id TEXT NOT NULL,
    native_session_id TEXT,
    canonical_path TEXT NOT NULL,
    repository TEXT,
    repository_verified INTEGER NOT NULL DEFAULT 0,
    generation TEXT NOT NULL,
    generation_seq INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL,
    observed_size INTEGER NOT NULL DEFAULT 0,
    offset INTEGER NOT NULL DEFAULT 0,
    prefix_hash TEXT,
    boundary_hash TEXT,
    parser_version TEXT NOT NULL,
    skipped_records INTEGER NOT NULL DEFAULT 0,
    pending_bytes INTEGER NOT NULL DEFAULT 0,
    parser_state TEXT,
    last_progress_ms INTEGER,
    last_error TEXT,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_sources_queue ON sources (state, updated_ms);
CREATE INDEX IF NOT EXISTS idx_sources_path ON sources (client, canonical_path);
CREATE TABLE IF NOT EXISTS source_generations (
    source_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    started_ms INTEGER NOT NULL,
    retired_ms INTEGER,
    disposition TEXT NOT NULL,
    PRIMARY KEY (source_id, generation)
) STRICT;
CREATE TABLE IF NOT EXISTS source_records (
    source_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    evidence_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    role TEXT,
    turn_index INTEGER,
    parent_key TEXT,
    branch TEXT,
    text TEXT NOT NULL,
    completeness TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    captured_ms INTEGER NOT NULL,
    PRIMARY KEY (source_id, generation, evidence_key)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_source_records_order ON source_records (source_id, generation, turn_index);
CREATE TABLE IF NOT EXISTS extraction_intents (
    source_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    state TEXT NOT NULL,
    through_offset INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER,
    terminal_reason TEXT,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY (source_id, generation)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_extraction_intents_state ON extraction_intents (state, next_attempt_ms);
"#;

/// Forward migration 4 -> 5: migration manifests, id maps, repository
/// mappings and suppression state.
const MIGRATION_5_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS migration_manifest (
    run_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    source_fingerprint TEXT NOT NULL,
    source_path TEXT NOT NULL,
    started_ms INTEGER NOT NULL,
    finished_ms INTEGER,
    counts_json TEXT NOT NULL DEFAULT '{}',
    cursor_json TEXT NOT NULL DEFAULT '{}',
    detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE IF NOT EXISTS migration_id_map (
    v1_id TEXT PRIMARY KEY,
    v2_id TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS migration_supersession (
    v1_id TEXT PRIMARY KEY,
    superseded_by_v1 TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS repository_mappings (
    legacy TEXT NOT NULL,
    canonical TEXT NOT NULL,
    ambiguous INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (legacy, canonical)
) STRICT;
ALTER TABLE suppressions ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppressions_identity
    ON suppressions (memory_id, scope, COALESCE(repository, ''), fingerprint);
"#;

/// Forward migration 3 -> 4: proposition identity, evidence links and
/// extraction leases.
const MIGRATION_4_SQL: &str = r#"
ALTER TABLE memories ADD COLUMN topic_key TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories (topic_key, scope, repository, authority, forgotten);
CREATE TABLE IF NOT EXISTS memory_evidence (
    memory_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    evidence_key TEXT NOT NULL,
    role TEXT,
    created_ms INTEGER NOT NULL,
    retired_ms INTEGER,
    PRIMARY KEY (memory_id, source_id, generation, evidence_key)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_memory_evidence_source ON memory_evidence (source_id, generation, evidence_key);
ALTER TABLE extraction_intents ADD COLUMN rule_version TEXT NOT NULL DEFAULT '';
ALTER TABLE extraction_intents ADD COLUMN lease_token TEXT;
ALTER TABLE extraction_intents ADD COLUMN lease_owner TEXT;
ALTER TABLE extraction_intents ADD COLUMN lease_expires_ms INTEGER;
"#;

/// Lexical candidates plus the snapshot revision they were read at.
#[derive(Debug, Clone)]
pub struct LexicalSnapshot {
    pub memory_revision: i64,
    pub derived_generation: i64,
    pub pool: Vec<MemoryRecord>,
    pub truncated: bool,
}

/// Required context assembled independently of the query.
struct RequiredContext {
    records: Vec<MemoryRecord>,
    sections: Vec<RecallSection>,
    text: String,
    omitted: u64,
    truncated: bool,
}

/// Semantic inputs for a fused recall.
pub struct SemanticInput<'a> {
    pub identity: &'a str,
    pub vector: Option<&'a [f32]>,
    pub min_similarity: f64,
    pub fallback_reason: Option<&'a str>,
    pub cache_state: &'a str,
}

/// Maintained status view of one store.
#[derive(Debug, Clone)]
pub struct StoreStatus {
    pub store_id: String,
    pub schema_version: i64,
    pub memory_revision: i64,
    pub derived_generation: i64,
    pub active_memories: i64,
    pub forgotten_memories: i64,
    pub receipts: i64,
}

/// Handle to the single v2 store.
pub struct Store {
    writer: Mutex<Connection>,
    readers: Vec<Mutex<Connection>>,
    next_reader: AtomicUsize,
    limits: Limits,
    /// Provider identity when embeddings are enabled.
    embedding_identity: Option<String>,
    /// Whether a provider is configured at all (intents become pending).
    embedding_enabled: bool,
}

impl Store {
    /// Open (creating or validating) the store for a resolved config.
    pub fn open(config: &ResolvedConfig) -> CoreResult<Self> {
        let writer = open_connection(&config.store_path)?;
        migrate(&writer)?;
        let mut readers = Vec::with_capacity(4);
        for _ in 0..4 {
            readers.push(Mutex::new(open_connection(&config.store_path)?));
        }
        Ok(Self {
            writer: Mutex::new(writer),
            readers,
            next_reader: AtomicUsize::new(0),
            limits: config.limits.clone(),
            embedding_identity: config.embedding_identity.clone(),
            embedding_enabled: config.embedding_identity.is_some(),
        })
    }

    /// Open a migration staging store without a running configuration.
    pub fn open_migration_store(path: &Path) -> CoreResult<Self> {
        let writer = open_connection(path)?;
        migrate(&writer)?;
        let mut readers = Vec::with_capacity(2);
        for _ in 0..2 {
            readers.push(Mutex::new(open_connection(path)?));
        }
        Ok(Self {
            writer: Mutex::new(writer),
            readers,
            next_reader: AtomicUsize::new(0),
            limits: Limits::default(),
            embedding_identity: None,
            embedding_enabled: false,
        })
    }

    /// Provider identity for embedding work, when enabled.
    pub fn embedding_identity(&self) -> Option<&str> {
        self.embedding_identity.as_deref()
    }

    /// Round-robin read connection for parallel readers.
    fn reader(&self) -> &Mutex<Connection> {
        let index = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        &self.readers[index]
    }

    /// Persisted reconciliation cursor, if a page is in flight.
    pub fn reconciliation_cursor(&self) -> CoreResult<Option<String>> {
        let connection = self.writer.lock().expect("writer lock");
        Ok(connection
            .query_row(
                "SELECT reconciliation_cursor FROM store_metadata WHERE id = 1",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// Read an operation receipt for explicit operator actions.
    pub fn lookup_receipt_json(
        &self,
        client_id: &str,
        operation: &str,
        key: &str,
    ) -> CoreResult<Option<(String, String)>> {
        let connection = self.writer.lock().expect("writer lock");
        lookup_receipt(&connection, client_id, operation, key)
    }

    /// Persist an operation receipt for explicit operator actions.
    pub fn store_receipt_json(
        &self,
        client_id: &str,
        operation: &str,
        key: &str,
        request_hash: &str,
        response_json: &str,
        now_ms: i64,
    ) -> CoreResult<()> {
        let connection = self.writer.lock().expect("writer lock");
        store_receipt(
            &connection,
            client_id,
            operation,
            key,
            request_hash,
            response_json,
            now_ms,
        )
    }

    /// Limits in effect for this store.
    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// Interrupt handle for the next reader, used by tooling and tests.
    pub fn interrupt_handle(&self) -> CoreResult<rusqlite::InterruptHandle> {
        let index = self.next_reader.load(Ordering::Relaxed) % self.readers.len();
        let connection = self.readers[index].lock().expect("reader lock");
        Ok(connection.get_interrupt_handle())
    }

    /// Cheap maintained counters for Status.
    pub fn status(&self) -> CoreResult<StoreStatus> {
        let connection = self.writer.lock().expect("writer lock");
        let status = connection.query_row(
            "SELECT store_id, schema_version, memory_revision, derived_generation, \
             active_memories, forgotten_memories FROM store_metadata WHERE id = 1",
            [],
            |row| {
                Ok(StoreStatus {
                    store_id: row.get(0)?,
                    schema_version: row.get(1)?,
                    memory_revision: row.get(2)?,
                    derived_generation: row.get(3)?,
                    active_memories: row.get(4)?,
                    forgotten_memories: row.get(5)?,
                    receipts: 0,
                })
            },
        )?;
        let receipts =
            connection.query_row("SELECT COUNT(*) FROM idempotency_receipts", [], |row| {
                row.get(0)
            })?;
        Ok(StoreStatus { receipts, ..status })
    }

    /// Retain one manual semantic memory.
    pub fn retain(
        &self,
        client_id: &str,
        params: &RetainParams,
        now_ms: i64,
    ) -> CoreResult<RetainResult> {
        self.retain_with_failpoint(client_id, params, now_ms, false)
    }

    /// Retain with a test-only failpoint before commit.
    pub fn retain_with_failpoint(
        &self,
        client_id: &str,
        params: &RetainParams,
        now_ms: i64,
        fail_before_commit: bool,
    ) -> CoreResult<RetainResult> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let request_hash = policy::retain_request_hash(params);
        if let Some((stored_hash, response)) = lookup_receipt(
            &transaction,
            client_id,
            RECEIPT_OP_RETAIN,
            &params.idempotency_key,
        )? {
            if stored_hash != request_hash {
                return Err(CoreError::conflict(
                    "IDEMPOTENCY_CONFLICT",
                    "the idempotency key was used with a different payload",
                ));
            }
            return Ok(serde_json::from_str(&response)?);
        }

        let total: i64 =
            transaction.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))?;
        if total >= self.limits.max_memories {
            return Err(CoreError::quota(
                "STORE_QUOTA",
                "authoritative memory cap reached",
            ));
        }
        let receipts: i64 =
            transaction.query_row("SELECT COUNT(*) FROM idempotency_receipts", [], |row| {
                row.get(0)
            })?;
        if receipts >= self.limits.max_receipts {
            return Err(CoreError::quota("STORE_QUOTA", "retry receipt cap reached"));
        }

        let revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )? + 1;
        let memory_id = Uuid::new_v4().to_string();
        let confidence = params.confidence.unwrap_or(1.0);
        let tags = canonical_tags(&params.tags);
        let tags_json = serde_json::to_string(&tags)?;
        let content_hash = policy::sha256_hex(params.content.as_bytes());
        let scope = policy::scope_str(params.scope);

        transaction.execute(
            "INSERT INTO memories (id, kind, content, content_hash, scope, repository, authority, \
             confidence, tags_json, source_session_id, created_ms, updated_ms, expires_at_ms, revision, forgotten) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'manual', ?7, ?8, ?9, ?10, ?10, ?11, ?12, 0)",
            params![
                memory_id,
                params.kind,
                params.content,
                content_hash,
                scope,
                params.repository,
                confidence,
                tags_json,
                params.source_session_id,
                now_ms,
                params.expires_at_ms,
                revision
            ],
        )?;
        transaction.execute(
            "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, ?2, ?3, ?4)",
            params![params.content, params.kind, tags.join(" "), memory_id],
        )?;
        let intent_state = if self.embedding_enabled {
            "pending"
        } else {
            "disabled"
        };
        transaction.execute(
            "INSERT INTO embedding_intents \
             (memory_id, desired_revision, state, attempts, next_attempt_ms, terminal_reason, content_hash, model_identity, updated_ms) \
             VALUES (?1, ?2, ?3, 0, NULL, NULL, ?4, ?5, ?6)",
            params![
                memory_id,
                revision,
                intent_state,
                content_hash,
                self.embedding_identity.as_deref().unwrap_or(""),
                now_ms
            ],
        )?;
        transaction.execute(
            "UPDATE store_metadata SET memory_revision = ?1, active_memories = active_memories + 1 WHERE id = 1",
            params![revision],
        )?;

        let result = RetainResult {
            memory_id,
            committed_revision: revision.to_string(),
            write_result: "created".to_string(),
            embedding_status: "disabled".to_string(),
        };
        let response_json = serde_json::to_string(&result)?;
        store_receipt(
            &transaction,
            client_id,
            RECEIPT_OP_RETAIN,
            &params.idempotency_key,
            &request_hash,
            &response_json,
            now_ms,
        )?;

        if fail_before_commit {
            return Err(CoreError::internal(
                "INJECTED_FAILURE",
                "test failpoint before commit",
            ));
        }
        transaction.commit()?;
        Ok(result)
    }

    /// Forget one existing memory.
    pub fn forget(
        &self,
        client_id: &str,
        params: &ForgetParams,
        now_ms: i64,
    ) -> CoreResult<ForgetResult> {
        self.forget_with_failpoint(client_id, params, now_ms, false)
    }

    /// Forget with a test-only failpoint before commit.
    pub fn forget_with_failpoint(
        &self,
        client_id: &str,
        params: &ForgetParams,
        now_ms: i64,
        fail_before_commit: bool,
    ) -> CoreResult<ForgetResult> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let request_hash = policy::forget_request_hash(&params.memory_id, params.reason.as_deref());
        if let Some((stored_hash, response)) = lookup_receipt(
            &transaction,
            client_id,
            RECEIPT_OP_FORGET,
            &params.idempotency_key,
        )? {
            if stored_hash != request_hash {
                return Err(CoreError::conflict(
                    "IDEMPOTENCY_CONFLICT",
                    "the idempotency key was used with a different payload",
                ));
            }
            return Ok(serde_json::from_str(&response)?);
        }

        let row: Option<(i64, String, String, Option<String>)> = transaction
            .query_row(
                "SELECT forgotten, content_hash, scope, repository FROM memories WHERE id = ?1",
                params![params.memory_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((forgotten, content_hash, scope, repository)) = row else {
            return Err(CoreError::not_found(
                "MEMORY_NOT_FOUND",
                "no memory exists with that ID",
            ));
        };

        let revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )?;

        let result = if forgotten != 0 {
            ForgetResult {
                memory_id: params.memory_id.clone(),
                committed_revision: revision.to_string(),
                write_result: "alreadyForgotten".to_string(),
            }
        } else {
            let next_revision = revision + 1;
            transaction.execute(
                "UPDATE memories SET forgotten = 1, content = '', revision = ?2, updated_ms = ?3 WHERE id = ?1",
                params![params.memory_id, next_revision, now_ms],
            )?;
            transaction.execute(
                "DELETE FROM memory_fts WHERE memory_id = ?1",
                params![params.memory_id],
            )?;
            transaction.execute(
                "DELETE FROM memory_vectors WHERE memory_id = ?1",
                params![params.memory_id],
            )?;
            transaction.execute(
                "UPDATE embedding_jobs SET state = 'obsolete', lease_token = NULL, lease_owner = NULL, \
                 lease_expires_ms = NULL, updated_ms = ?1 WHERE memory_id = ?2 \
                 AND state IN ('queued', 'running', 'retry_wait')",
                params![now_ms, params.memory_id],
            )?;
            transaction.execute(
                "UPDATE embedding_intents SET state = 'obsolete', updated_ms = ?1 WHERE memory_id = ?2",
                params![now_ms, params.memory_id],
            )?;
            transaction.execute(
                "INSERT INTO suppressions (memory_id, scope, repository, fingerprint, reason, revision, created_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    params.memory_id,
                    scope,
                    repository,
                    content_hash,
                    params.reason,
                    next_revision,
                    now_ms
                ],
            )?;
            transaction.execute(
                "UPDATE store_metadata SET memory_revision = ?1, \
                 active_memories = active_memories - 1, forgotten_memories = forgotten_memories + 1 WHERE id = 1",
                params![next_revision],
            )?;
            ForgetResult {
                memory_id: params.memory_id.clone(),
                committed_revision: next_revision.to_string(),
                write_result: "forgotten".to_string(),
            }
        };

        let response_json = serde_json::to_string(&result)?;
        store_receipt(
            &transaction,
            client_id,
            RECEIPT_OP_FORGET,
            &params.idempotency_key,
            &request_hash,
            &response_json,
            now_ms,
        )?;

        if fail_before_commit {
            return Err(CoreError::internal(
                "INJECTED_FAILURE",
                "test failpoint before commit",
            ));
        }
        transaction.commit()?;
        Ok(result)
    }

    /// Lexical recall under scope policy with a bounded candidate pool.
    ///
    /// The deadline is enforced cooperatively between steps and by a watchdog
    /// that interrupts the reader connection once the budget expires.
    pub fn recall(
        &self,
        params: &RecallParams,
        now_ms: i64,
        limit: u32,
        context_bytes: u32,
        deadline: Option<Instant>,
    ) -> CoreResult<RecallResult> {
        ensure_within(deadline)?;
        let index = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let connection = self.readers[index].lock().expect("reader lock");
        let done = Arc::new(AtomicBool::new(false));
        let expired = Arc::new(AtomicBool::new(false));
        let watchdog = deadline.map(|deadline_at| {
            let done = Arc::clone(&done);
            let expired = Arc::clone(&expired);
            let handle = connection.get_interrupt_handle();
            std::thread::spawn(move || {
                loop {
                    let now = Instant::now();
                    if now >= deadline_at {
                        break;
                    }
                    std::thread::sleep((deadline_at - now).min(Duration::from_millis(5)));
                }
                if !done.load(Ordering::Acquire) {
                    expired.store(true, Ordering::Release);
                    handle.interrupt();
                }
            })
        });
        let result = self.recall_on(&connection, params, now_ms, limit, context_bytes, deadline);
        done.store(true, Ordering::Release);
        drop(watchdog);
        if expired.load(Ordering::Acquire) {
            return Err(CoreError::deadline("recall deadline exceeded"));
        }
        result
    }

    /// Required context sections: standing guidance and identity, assembled
    /// independently of topical similarity and protected before topical
    /// material. Sections are ordered directives -> identity -> preferences.
    fn required_context(
        &self,
        connection: &Connection,
        params: &RecallParams,
        now_ms: i64,
        budget: usize,
        deadline: Option<Instant>,
    ) -> CoreResult<RequiredContext> {
        let mut sql = String::from(
            "SELECT m.id, m.kind, m.content, m.scope, m.repository, m.authority, m.confidence, \
             m.created_ms, m.updated_ms, m.expires_at_ms, m.source_session_id, m.tags_json \
             FROM memories m WHERE m.forgotten = 0 AND m.superseded_by IS NULL \
             AND (m.expires_at_ms IS NULL OR m.expires_at_ms > ?1) \
             AND m.kind IN ('directive', 'rejected_approach', 'commitment', 'assistant_identity', \
             'user_identity', 'interaction_style', 'recurring_mistake', 'user_preference')",
        );
        let mut values: Vec<Value> = vec![Value::Integer(now_ms)];
        match params.repository.as_deref() {
            None => sql.push_str(" AND m.scope = 'global'"),
            Some(repository) => {
                sql.push_str(
                    " AND (m.scope = 'global' OR m.repository = ?2 \
                     OR (?3 = 1 AND m.scope = 'transferable' AND m.repository <> ?2))",
                );
                values.push(Value::Text(repository.to_string()));
                values.push(Value::Integer(i64::from(params.include_other_repositories)));
            }
        }
        sql.push_str(
            " ORDER BY CASE m.authority WHEN 'manual' THEN 0 ELSE 1 END, m.updated_ms DESC, m.id ASC LIMIT 64",
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values.iter()), |row| {
            let tags_json: String = row.get(11)?;
            let scope: String = row.get(3)?;
            Ok(MemoryRecord {
                id: row.get(0)?,
                kind: row.get(1)?,
                content: row.get(2)?,
                scope: parse_scope(&scope),
                repository: row.get(4)?,
                authority: row.get(5)?,
                confidence: row.get(6)?,
                created_ms: row.get(7)?,
                updated_ms: row.get(8)?,
                expires_at_ms: row.get(9)?,
                source_session_id: row.get(10)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            })
        })?;
        let records: Vec<MemoryRecord> = rows.collect::<Result<_, _>>()?;
        drop(statement);
        ensure_within(deadline)?;

        let sections: [(&str, &[&str]); 3] = [
            (
                "directives",
                &["directive", "rejected_approach", "commitment"],
            ),
            (
                "identity",
                &[
                    "assistant_identity",
                    "user_identity",
                    "interaction_style",
                    "recurring_mistake",
                ],
            ),
            ("preferences", &["user_preference"]),
        ];
        let mut remaining = budget;
        let mut included: Vec<MemoryRecord> = Vec::new();
        let mut rendered_sections = Vec::new();
        let mut rendered_text = Vec::new();
        let mut omitted = 0u64;
        let mut truncated = false;
        for (section_id, kinds) in sections {
            let items: Vec<&MemoryRecord> = records
                .iter()
                .filter(|record| kinds.contains(&record.kind.as_str()))
                .collect();
            if items.is_empty() || remaining == 0 {
                if !items.is_empty() {
                    truncated = true;
                    omitted += items.len() as u64;
                }
                continue;
            }
            let contents: Vec<String> = items.iter().map(|record| record.content.clone()).collect();
            let (text, taken, section_omitted) = retrieval::render_topical(&contents, remaining);
            if section_omitted > 0 {
                truncated = true;
            }
            omitted += section_omitted as u64;
            remaining = remaining.saturating_sub(text.len() + 1);
            included.extend(items.iter().take(taken).map(|record| (*record).clone()));
            if taken > 0 {
                rendered_sections.push(RecallSection {
                    id: section_id.to_string(),
                    memory_ids: items
                        .iter()
                        .take(taken)
                        .map(|record| record.id.clone())
                        .collect(),
                    text: text.clone(),
                    omitted: section_omitted as u64,
                });
                rendered_text.push(text);
            }
        }
        Ok(RequiredContext {
            records: included,
            sections: rendered_sections,
            text: rendered_text.join("\n"),
            omitted,
            truncated,
        })
    }

    fn recall_on(
        &self,
        connection: &Connection,
        params: &RecallParams,
        now_ms: i64,
        limit: u32,
        context_bytes: u32,
        deadline: Option<Instant>,
    ) -> CoreResult<RecallResult> {
        let transaction = connection.unchecked_transaction()?;

        let (memory_revision, derived_generation): (i64, i64) = transaction.query_row(
            "SELECT memory_revision, derived_generation FROM store_metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let terms = retrieval::extract_terms(&params.query);
        let base = |records: Vec<MemoryRecord>,
                    context: String,
                    section: Vec<RecallSection>,
                    omitted: u64,
                    truncated: bool,
                    response_bytes: u64| RecallResult {
            records,
            context,
            sections: section,
            memory_revision: memory_revision.to_string(),
            evaluated_at_ms: now_ms,
            derived_generation: derived_generation.to_string(),
            diagnostics: RecallDiagnostics {
                retrieval_mode: "lexical".to_string(),
                cache: "disabled".to_string(),
                vector_contribution: 0,
                candidate_pool_limit: self.limits.candidate_pool as u64,
                candidate_pool_truncated: truncated,
                fallback_reason: "DISABLED".to_string(),
                response_bytes,
                omitted_count: omitted,
                mandatory_truncated: false,
                mandatory_omitted: 0,
            },
        };

        let required = self.required_context(
            &transaction,
            params,
            now_ms,
            context_bytes as usize,
            deadline,
        )?;

        if terms.is_empty() {
            let mut result = base(
                required.records,
                required.text,
                required.sections,
                required.omitted,
                false,
                0,
            );
            result.diagnostics.mandatory_truncated = required.truncated;
            result.diagnostics.mandatory_omitted = required.omitted;
            return Ok(result);
        }

        let fts = retrieval::fts_query(&terms);
        let mut pool = self.fetch_candidates(&transaction, &fts, params, now_ms)?;
        if pool.is_empty() && terms.len() > 1 {
            let fallback = retrieval::fts_query_or(&terms);
            pool = self.fetch_candidates(&transaction, &fallback, params, now_ms)?;
        }
        ensure_within(deadline)?;

        let truncated = pool.len() >= self.limits.candidate_pool;
        let topical_budget = (context_bytes as usize).saturating_sub(required.text.len() + 1);
        let mut topical_selected: Vec<MemoryRecord> = pool
            .into_iter()
            .take((limit as usize).saturating_sub(required.records.len()))
            .collect();
        let mut mandatory_truncated = required.truncated;
        let mut mandatory_omitted = required.omitted;
        let mut omitted = 0u64;

        // Bound the encoded response; drop topical records first, then
        // required records only as a last resort (reported explicitly).
        loop {
            ensure_within(deadline)?;
            let contents: Vec<String> = topical_selected
                .iter()
                .map(|record| record.content.clone())
                .collect();
            let (text, included, context_omitted) =
                retrieval::render_topical(&contents, topical_budget);
            let mut selected = required.records.clone();
            selected.extend(topical_selected.clone());
            let mut sections = required.sections.clone();
            if !topical_selected.is_empty() {
                sections.push(RecallSection {
                    id: "topical".to_string(),
                    memory_ids: topical_selected
                        .iter()
                        .take(included)
                        .map(|record| record.id.clone())
                        .collect(),
                    text: text.clone(),
                    omitted: context_omitted as u64,
                });
            }
            let context = if required.text.is_empty() {
                text.clone()
            } else if text.is_empty() {
                required.text.clone()
            } else {
                format!("{}\n{text}", required.text)
            };
            let result = base(
                selected,
                context,
                sections,
                omitted + context_omitted as u64 + mandatory_omitted,
                truncated,
                0,
            );
            let encoded = serde_json::to_vec(&result)?;
            if encoded.len() + RESPONSE_HEADROOM <= MAX_BODY_BYTES
                || (topical_selected.is_empty() && required.records.is_empty())
            {
                let response_bytes = encoded.len() as u64;
                let mut final_result = result;
                final_result.diagnostics.response_bytes = response_bytes;
                final_result.diagnostics.mandatory_truncated = mandatory_truncated;
                final_result.diagnostics.mandatory_omitted = mandatory_omitted;
                return Ok(final_result);
            }
            if !topical_selected.is_empty() {
                topical_selected.pop();
                omitted += 1;
            } else if !required.records.is_empty() {
                // Required content only shrinks when the response cannot fit;
                // the omission stays visible in diagnostics.
                mandatory_truncated = true;
                mandatory_omitted += 1;
                omitted += 1;
            }
        }
    }

    /// Lexical candidates plus the revision they were read at. The speculative
    /// result is reusable only while the revision is unchanged.
    pub fn lexical_snapshot(
        &self,
        params: &RecallParams,
        now_ms: i64,
        deadline: Option<Instant>,
    ) -> CoreResult<LexicalSnapshot> {
        ensure_within(deadline)?;
        let index = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let connection = self.readers[index].lock().expect("reader lock");
        let transaction = connection.unchecked_transaction()?;
        let (memory_revision, derived_generation): (i64, i64) = transaction.query_row(
            "SELECT memory_revision, derived_generation FROM store_metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let terms = retrieval::extract_terms(&params.query);
        if terms.is_empty() {
            return Ok(LexicalSnapshot {
                memory_revision,
                derived_generation,
                pool: Vec::new(),
                truncated: false,
            });
        }
        let mut pool =
            self.fetch_candidates(&transaction, &retrieval::fts_query(&terms), params, now_ms)?;
        if pool.is_empty() && terms.len() > 1 {
            pool = self.fetch_candidates(
                &transaction,
                &retrieval::fts_query_or(&terms),
                params,
                now_ms,
            )?;
        }
        let truncated = pool.len() >= self.limits.candidate_pool;
        Ok(LexicalSnapshot {
            memory_revision,
            derived_generation,
            pool,
            truncated,
        })
    }

    /// Fused lexical and semantic recall under one read snapshot.
    #[allow(clippy::too_many_arguments)]
    pub fn recall_fused(
        &self,
        params: &RecallParams,
        now_ms: i64,
        limit: u32,
        context_bytes: u32,
        speculative: Option<&LexicalSnapshot>,
        semantic: SemanticInput<'_>,
        deadline: Option<Instant>,
    ) -> CoreResult<RecallResult> {
        ensure_within(deadline)?;
        let index = self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len();
        let connection = self.readers[index].lock().expect("reader lock");
        let done = Arc::new(AtomicBool::new(false));
        let expired = Arc::new(AtomicBool::new(false));
        let watchdog = deadline.map(|deadline_at| {
            let done = Arc::clone(&done);
            let expired = Arc::clone(&expired);
            let handle = connection.get_interrupt_handle();
            std::thread::spawn(move || {
                loop {
                    let now = Instant::now();
                    if now >= deadline_at {
                        break;
                    }
                    std::thread::sleep((deadline_at - now).min(Duration::from_millis(5)));
                }
                if !done.load(Ordering::Acquire) {
                    expired.store(true, Ordering::Release);
                    handle.interrupt();
                }
            })
        });
        let result = self.recall_fused_on(
            &connection,
            params,
            now_ms,
            limit,
            context_bytes,
            speculative,
            semantic,
            deadline,
        );
        done.store(true, Ordering::Release);
        drop(watchdog);
        if expired.load(Ordering::Acquire) {
            return Err(CoreError::deadline("recall deadline exceeded"));
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn recall_fused_on(
        &self,
        connection: &Connection,
        params: &RecallParams,
        now_ms: i64,
        limit: u32,
        context_bytes: u32,
        speculative: Option<&LexicalSnapshot>,
        semantic: SemanticInput<'_>,
        deadline: Option<Instant>,
    ) -> CoreResult<RecallResult> {
        let transaction = connection.unchecked_transaction()?;
        let (memory_revision, derived_generation): (i64, i64) = transaction.query_row(
            "SELECT memory_revision, derived_generation FROM store_metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let terms = retrieval::extract_terms(&params.query);

        // Lexical candidates: reuse a speculative snapshot only when the
        // authoritative revision did not move under it.
        let (pool, lexical_truncated) = match speculative {
            Some(snapshot) if snapshot.memory_revision == memory_revision && !terms.is_empty() => {
                (snapshot.pool.clone(), snapshot.truncated)
            }
            _ => {
                if terms.is_empty() {
                    (Vec::new(), false)
                } else {
                    let mut pool = self.fetch_candidates(
                        &transaction,
                        &retrieval::fts_query(&terms),
                        params,
                        now_ms,
                    )?;
                    if pool.is_empty() && terms.len() > 1 {
                        pool = self.fetch_candidates(
                            &transaction,
                            &retrieval::fts_query_or(&terms),
                            params,
                            now_ms,
                        )?;
                    }
                    let truncated = pool.len() >= self.limits.candidate_pool;
                    (pool, truncated)
                }
            }
        };

        // Vector scoring in bounded pages, capped by eligible-vector work.
        let mut vector_rank: Vec<(String, f64)> = Vec::new();
        let mut fallback_reason = semantic.fallback_reason.unwrap_or("NONE").to_string();
        if let Some(vector) = semantic.vector {
            if semantic.identity.is_empty() {
                fallback_reason = "DISABLED".to_string();
            } else {
                let query_norm = embedding::vector_norm(vector);
                let mut after: Option<String> = None;
                let mut scanned = 0usize;
                let mut budget_exhausted = false;
                while scanned < MAX_VECTOR_SCAN {
                    let page = self.vector_page(
                        &transaction,
                        semantic.identity,
                        after.as_deref(),
                        VECTOR_PAGE,
                        params.repository.as_deref(),
                        params.include_other_repositories,
                        now_ms,
                    )?;
                    if page.is_empty() {
                        break;
                    }
                    after = page.last().map(|stored| stored.memory_id.clone());
                    for stored in page {
                        scanned += 1;
                        let score = embedding::cosine(
                            vector,
                            query_norm,
                            &stored.vector,
                            embedding::vector_norm(&stored.vector),
                        );
                        if score >= semantic.min_similarity {
                            vector_rank.push((stored.memory_id, score));
                        }
                    }
                    if ensure_within(deadline).is_err() {
                        budget_exhausted = true;
                        break;
                    }
                }
                if budget_exhausted {
                    vector_rank.clear();
                    fallback_reason = "VECTOR_BUDGET".to_string();
                } else {
                    vector_rank.sort_by(|left, right| {
                        right
                            .1
                            .partial_cmp(&left.1)
                            .unwrap_or(std::cmp::Ordering::Equal)
                            .then_with(|| left.0.cmp(&right.0))
                    });
                    if scanned == 0 {
                        fallback_reason = "NO_CURRENT_VECTORS".to_string();
                    } else if vector_rank.is_empty() && fallback_reason == "NONE" {
                        fallback_reason = "NO_RELEVANT_VECTOR".to_string();
                    }
                }
            }
        }

        // Candidate merge. A healthy vector list is authoritative for its
        // qualifying rows (ordered by cosine), and lexical-only rows fill
        // remaining slots in bm25 order. The planning note called for
        // equal-weight RRF; the calibration report records that equal weights
        // systematically demoted pure-semantic matches below the equivalent
        // v1 semantic mode, so this implementation keeps semantic precedence
        // and uses lexical rank only where no qualifying vector exists.
        let vector_ids: HashSet<String> = vector_rank.iter().map(|(id, _)| id.clone()).collect();
        let mut fused: Vec<(String, u8, usize)> = Vec::new();
        for (rank, (id, _)) in vector_rank.iter().enumerate() {
            fused.push((id.clone(), 0, rank));
        }
        for (rank, record) in pool.iter().enumerate() {
            if !vector_ids.contains(&record.id) {
                fused.push((record.id.clone(), 1, rank));
            }
        }
        fused.sort_by(|left, right| {
            left.1
                .cmp(&right.1)
                .then_with(|| left.2.cmp(&right.2))
                .then_with(|| left.0.cmp(&right.0))
        });
        fused.truncate(limit as usize);

        // Materialize complete records in fused order from this snapshot.
        let by_id: HashMap<&str, &MemoryRecord> = pool
            .iter()
            .map(|record| (record.id.as_str(), record))
            .collect();
        let missing: Vec<String> = fused
            .iter()
            .filter(|(id, _, _)| !by_id.contains_key(id.as_str()))
            .map(|(id, _, _)| id.clone())
            .collect();
        let fetched = if missing.is_empty() {
            Vec::new()
        } else {
            self.fetch_records_by_ids(&transaction, &missing)?
        };
        let fetched_map: HashMap<&str, &MemoryRecord> = fetched
            .iter()
            .map(|record| (record.id.as_str(), record))
            .collect();
        let mut selected: Vec<MemoryRecord> = Vec::with_capacity(fused.len());

        for (id, _, _) in &fused {
            if let Some(record) = by_id.get(id.as_str()) {
                selected.push((*record).clone());
            } else if let Some(record) = fetched_map.get(id.as_str()) {
                selected.push((*record).clone());
            }
        }

        let required = self.required_context(
            &transaction,
            params,
            now_ms,
            context_bytes as usize,
            deadline,
        )?;
        if terms.is_empty() {
            let mut result = RecallResult {
                records: required.records,
                context: required.text,
                sections: required.sections,
                memory_revision: memory_revision.to_string(),
                evaluated_at_ms: now_ms,
                derived_generation: derived_generation.to_string(),
                diagnostics: RecallDiagnostics {
                    retrieval_mode: "lexical".to_string(),
                    cache: semantic.cache_state.to_string(),
                    vector_contribution: 0,
                    candidate_pool_limit: self.limits.candidate_pool as u64,
                    candidate_pool_truncated: false,
                    fallback_reason: fallback_reason.clone(),
                    response_bytes: 0,
                    omitted_count: required.omitted,
                    mandatory_truncated: required.truncated,
                    mandatory_omitted: required.omitted,
                },
            };
            let encoded = serde_json::to_vec(&result)?;
            result.diagnostics.response_bytes = encoded.len() as u64;
            return Ok(result);
        }

        let vector_contribution = selected
            .iter()
            .filter(|record| vector_ids.contains(&record.id))
            .count() as u64;
        let retrieval_mode = if vector_contribution > 0 {
            "hybrid"
        } else {
            "lexical"
        };
        if vector_contribution == 0 && semantic.vector.is_some() && fallback_reason == "NONE" {
            fallback_reason = "NO_RELEVANT_VECTOR".to_string();
        }

        // Bound the encoded response; required sections render first and
        // topical records are dropped before any required item.
        let mut omitted = 0u64;
        let topical_budget = (context_bytes as usize).saturating_sub(required.text.len() + 1);
        let mut mandatory_truncated = required.truncated;
        let mut mandatory_omitted = required.omitted;
        let mut mandatory = required.records.clone();
        loop {
            ensure_within(deadline)?;
            let contents: Vec<String> = selected
                .iter()
                .map(|record| record.content.clone())
                .collect();
            let (text, included, context_omitted) =
                retrieval::render_topical(&contents, topical_budget);
            let mut sections = required.sections.clone();
            if !selected.is_empty() {
                sections.push(RecallSection {
                    id: "topical".to_string(),
                    memory_ids: selected
                        .iter()
                        .take(included)
                        .map(|record| record.id.clone())
                        .collect(),
                    text: text.clone(),
                    omitted: context_omitted as u64,
                });
            }
            let context = if required.text.is_empty() {
                text.clone()
            } else if text.is_empty() {
                required.text.clone()
            } else {
                format!("{}\n{text}", required.text)
            };
            let mut records = mandatory.clone();
            records.extend(selected.clone());
            let result = RecallResult {
                records,
                context,
                sections,
                memory_revision: memory_revision.to_string(),
                evaluated_at_ms: now_ms,
                derived_generation: derived_generation.to_string(),
                diagnostics: RecallDiagnostics {
                    retrieval_mode: retrieval_mode.to_string(),
                    cache: semantic.cache_state.to_string(),
                    vector_contribution,
                    candidate_pool_limit: self.limits.candidate_pool as u64,
                    candidate_pool_truncated: lexical_truncated,
                    fallback_reason: fallback_reason.clone(),
                    response_bytes: 0,
                    omitted_count: omitted + context_omitted as u64 + mandatory_omitted,
                    mandatory_truncated,
                    mandatory_omitted,
                },
            };
            let encoded = serde_json::to_vec(&result)?;
            if encoded.len() + RESPONSE_HEADROOM <= MAX_BODY_BYTES
                || (selected.is_empty() && mandatory.is_empty())
            {
                let mut final_result = result;
                final_result.diagnostics.response_bytes = encoded.len() as u64;
                return Ok(final_result);
            }
            if !selected.is_empty() {
                selected.pop();
                omitted += 1;
            } else if !mandatory.is_empty() {
                mandatory_truncated = true;
                mandatory_omitted += 1;
                omitted += 1;
                mandatory.pop();
            }
        }
    }

    /// Fetch complete records for specific IDs from one snapshot.
    fn fetch_records_by_ids(
        &self,
        connection: &Connection,
        ids: &[String],
    ) -> CoreResult<Vec<MemoryRecord>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "SELECT id, kind, content, scope, repository, authority, confidence, created_ms, \
             updated_ms, expires_at_ms, source_session_id, tags_json FROM memories \
             WHERE forgotten = 0 AND superseded_by IS NULL AND id IN ({placeholders})"
        );
        let values: Vec<Value> = ids.iter().map(|id| Value::Text(id.clone())).collect();
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values.iter()), |row| {
            let tags_json: String = row.get(11)?;
            let scope: String = row.get(3)?;
            Ok(MemoryRecord {
                id: row.get(0)?,
                kind: row.get(1)?,
                content: row.get(2)?,
                scope: parse_scope(&scope),
                repository: row.get(4)?,
                authority: row.get(5)?,
                confidence: row.get(6)?,
                created_ms: row.get(7)?,
                updated_ms: row.get(8)?,
                expires_at_ms: row.get(9)?,
                source_session_id: row.get(10)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn fetch_candidates(
        &self,
        connection: &Connection,
        fts: &str,
        params: &RecallParams,
        now_ms: i64,
    ) -> CoreResult<Vec<MemoryRecord>> {
        let mut sql = String::from(
            "SELECT m.id, m.kind, m.content, m.scope, m.repository, m.authority, m.confidence, \
             m.created_ms, m.updated_ms, m.expires_at_ms, m.source_session_id, m.tags_json, \
             bm25(memory_fts) AS rank \
             FROM memory_fts JOIN memories m ON m.id = memory_fts.memory_id \
             WHERE memory_fts MATCH ?1 AND m.forgotten = 0 AND m.superseded_by IS NULL \
             AND (m.expires_at_ms IS NULL OR m.expires_at_ms > ?2)",
        );
        let mut values: Vec<Value> = vec![Value::Text(fts.to_string()), Value::Integer(now_ms)];
        match params.repository.as_deref() {
            None => sql.push_str(" AND m.scope = 'global'"),
            Some(repository) => {
                sql.push_str(
                    " AND (m.scope = 'global' OR m.repository = ?3 \
                     OR (?4 = 1 AND m.scope = 'transferable' AND m.repository <> ?3))",
                );
                values.push(Value::Text(repository.to_string()));
                values.push(Value::Integer(i64::from(params.include_other_repositories)));
            }
        }
        sql.push_str(" ORDER BY rank ASC, m.id ASC LIMIT ?");
        values.push(Value::Integer(self.limits.candidate_pool as i64));

        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values.iter()), |row| {
            let tags_json: String = row.get(11)?;
            let scope: String = row.get(3)?;
            Ok(MemoryRecord {
                id: row.get(0)?,
                kind: row.get(1)?,
                content: row.get(2)?,
                scope: parse_scope(&scope),
                repository: row.get(4)?,
                authority: row.get(5)?,
                confidence: row.get(6)?,
                created_ms: row.get(7)?,
                updated_ms: row.get(8)?,
                expires_at_ms: row.get(9)?,
                source_session_id: row.get(10)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

fn ensure_within(deadline: Option<Instant>) -> CoreResult<()> {
    match deadline {
        Some(limit) if Instant::now() >= limit => {
            Err(CoreError::deadline("recall deadline exceeded"))
        }
        _ => Ok(()),
    }
}

fn parse_scope(value: &str) -> Scope {
    match value {
        "repo" => Scope::Repo,
        "transferable" => Scope::Transferable,
        _ => Scope::Global,
    }
}

fn canonical_tags(tags: &[String]) -> Vec<String> {
    let mut tags: Vec<String> = tags
        .iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect();
    tags.sort();
    tags.dedup();
    tags
}

fn open_connection(path: &Path) -> CoreResult<Connection> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", 2)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "busy_timeout", 5_000)?;
    connection.pragma_update(None, "cache_size", -2_048)?;
    Ok(connection)
}

fn table_exists(connection: &Connection, name: &str) -> CoreResult<bool> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn migrate(connection: &Connection) -> CoreResult<()> {
    if !table_exists(connection, "store_metadata")? {
        let tables: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )?;
        if tables > 0 {
            return Err(CoreError::internal(
                "SCHEMA_UNSUPPORTED",
                "database contains tables but no v2 metadata",
            ));
        }
        connection.execute_batch(SCHEMA_V1_SQL)?;
        connection.execute(
            "INSERT INTO store_metadata (id, store_id, schema_version, memory_revision, \
             derived_generation, active_memories, forgotten_memories) VALUES (1, ?1, 1, 0, 0, 0, 0)",
            params![Uuid::new_v4().to_string()],
        )?;
    }
    let version: Option<i64> = connection
        .query_row(
            "SELECT schema_version FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    match version {
        Some(1) => {
            connection.execute_batch(MIGRATION_2_SQL)?;
            connection.execute_batch(MIGRATION_3_SQL)?;
            connection.execute_batch(MIGRATION_4_SQL)?;
            connection.execute_batch(MIGRATION_5_SQL)?;
            connection.execute(
                "UPDATE store_metadata SET schema_version = 5 WHERE id = 1",
                [],
            )?;
        }
        Some(2) => {
            connection.execute_batch(MIGRATION_3_SQL)?;
            connection.execute_batch(MIGRATION_4_SQL)?;
            connection.execute_batch(MIGRATION_5_SQL)?;
            connection.execute(
                "UPDATE store_metadata SET schema_version = 5 WHERE id = 1",
                [],
            )?;
        }
        Some(3) => {
            connection.execute_batch(MIGRATION_4_SQL)?;
            connection.execute_batch(MIGRATION_5_SQL)?;
            connection.execute(
                "UPDATE store_metadata SET schema_version = 5 WHERE id = 1",
                [],
            )?;
        }
        Some(4) => {
            connection.execute_batch(MIGRATION_5_SQL)?;
            connection.execute(
                "UPDATE store_metadata SET schema_version = 5 WHERE id = 1",
                [],
            )?;
        }
        Some(version) if version == STORE_SCHEMA_VERSION => {}
        Some(version) => {
            return Err(CoreError::internal(
                "SCHEMA_UNSUPPORTED",
                format!("store schema {version} is not supported"),
            ));
        }
        None => {
            return Err(CoreError::internal(
                "SCHEMA_UNSUPPORTED",
                "store metadata row is missing",
            ));
        }
    }
    // Fail closed when FTS5 is unavailable or the index is unhealthy.
    connection.query_row("SELECT COUNT(*) FROM memory_fts", [], |row| {
        row.get::<_, i64>(0)
    })?;
    Ok(())
}

fn lookup_receipt(
    connection: &Connection,
    client_id: &str,
    operation: &str,
    key: &str,
) -> CoreResult<Option<(String, String)>> {
    Ok(connection
        .query_row(
            "SELECT request_hash, response_json FROM idempotency_receipts \
             WHERE client_id = ?1 AND operation = ?2 AND idempotency_key = ?3",
            params![client_id, operation, key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

#[allow(clippy::too_many_arguments)]
fn store_receipt(
    connection: &Connection,
    client_id: &str,
    operation: &str,
    key: &str,
    request_hash: &str,
    response_json: &str,
    now_ms: i64,
) -> CoreResult<()> {
    connection.execute(
        "INSERT INTO idempotency_receipts (client_id, operation, idempotency_key, request_hash, response_json, created_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![client_id, operation, key, request_hash, response_json, now_ms],
    )?;
    Ok(())
}
