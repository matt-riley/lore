//! Authoritative SQLite storage for the stage-2 store.
//!
//! One writer connection and four bounded read workers. Every authoritative
//! transaction commits memory, FTS, intent, revision, counters and receipt
//! together, so an acknowledgement survives process failure.

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

const RECEIPT_OP_RETAIN: &str = "retain";
const RECEIPT_OP_FORGET: &str = "forget";
/// Leave headroom for the envelope around a recall result.
const RESPONSE_HEADROOM: usize = 4 * 1024;

const SCHEMA_SQL: &str = r#"
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
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, kind, tags, memory_id UNINDEXED);
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
        })
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
        transaction.execute(
            "INSERT INTO embedding_intents (memory_id, desired_revision, state) VALUES (?1, ?2, 'disabled')",
            params![memory_id, revision],
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
            },
        };

        if terms.is_empty() {
            return Ok(base(Vec::new(), String::new(), Vec::new(), 0, false, 0));
        }

        let fts = retrieval::fts_query(&terms);
        let mut pool = self.fetch_candidates(&transaction, &fts, params, now_ms)?;
        if pool.is_empty() && terms.len() > 1 {
            let fallback = retrieval::fts_query_or(&terms);
            pool = self.fetch_candidates(&transaction, &fallback, params, now_ms)?;
        }
        ensure_within(deadline)?;

        let truncated = pool.len() >= self.limits.candidate_pool;
        let mut selected: Vec<MemoryRecord> = pool.into_iter().take(limit as usize).collect();
        let mut omitted = 0u64;

        // Bound the encoded response; drop whole records from the tail.
        loop {
            ensure_within(deadline)?;
            let contents: Vec<String> = selected
                .iter()
                .map(|record| record.content.clone())
                .collect();
            let (text, included, context_omitted) =
                retrieval::render_topical(&contents, context_bytes as usize);
            let section = if selected.is_empty() {
                Vec::new()
            } else {
                vec![RecallSection {
                    id: "topical".to_string(),
                    memory_ids: selected
                        .iter()
                        .take(included)
                        .map(|record| record.id.clone())
                        .collect(),
                    text: text.clone(),
                    omitted: context_omitted as u64,
                }]
            };
            let result = base(
                selected.clone(),
                text,
                section,
                omitted + context_omitted as u64,
                truncated,
                0,
            );
            let encoded = serde_json::to_vec(&result)?;
            if encoded.len() + RESPONSE_HEADROOM <= MAX_BODY_BYTES || selected.is_empty() {
                let response_bytes = encoded.len() as u64;
                let mut final_result = result;
                final_result.diagnostics.response_bytes = response_bytes;
                return Ok(final_result);
            }
            selected.pop();
            omitted += 1;
        }
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
        connection.execute_batch(SCHEMA_SQL)?;
        connection.execute(
            "INSERT INTO store_metadata (id, store_id, schema_version, memory_revision, \
             derived_generation, active_memories, forgotten_memories) VALUES (1, ?1, ?2, 0, 0, 0, 0)",
            params![Uuid::new_v4().to_string(), STORE_SCHEMA_VERSION],
        )?;
    } else {
        let version: Option<i64> = connection
            .query_row(
                "SELECT schema_version FROM store_metadata WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match version {
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
