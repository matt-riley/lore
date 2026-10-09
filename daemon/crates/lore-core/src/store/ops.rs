//! Durable operation runs and the preview/apply mutation protocol.
//!
//! Every apply records a run row; expensive multi-batch operations page their
//! items. Mutations default to preview, compute a deterministic fingerprint
//! over the decision inputs, require a pre-apply snapshot, and refuse to
//! apply when the fingerprint no longer matches.

use std::collections::BTreeMap;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult};
use crate::store::Store;

/// One durable operation run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRun {
    pub run_id: String,
    pub operation: String,
    pub state: String,
    pub input_hash: String,
    pub plan_fingerprint: Option<String>,
    pub store_id: String,
    pub actor: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub finished_ms: Option<i64>,
    pub counts: BTreeMap<String, i64>,
    pub terminal_reason: Option<String>,
}

/// Outcome of a correction apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectOutcome {
    pub run_id: String,
    pub memory_id: String,
    pub replaced_id: String,
    pub snapshot: String,
    pub committed_revision: i64,
}

/// Outcome of a purge apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeOutcome {
    pub run_id: String,
    pub purged: u64,
    pub snapshot: String,
    pub committed_revision: i64,
}

/// Outcome of a scope override apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeOutcome {
    pub run_id: String,
    pub updated: u64,
    pub committed_revision: i64,
}

pub(crate) fn fingerprint(operation: &str, store_id: &str, parts: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(operation.as_bytes());
    hasher.update([0]);
    hasher.update(store_id.as_bytes());
    for part in parts {
        hasher.update([0]);
        hasher.update(part.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

struct MemoryRow {
    kind: String,
    content: String,
    content_hash: String,
    scope: String,
    repository: Option<String>,
    authority: String,
    confidence: f64,
    tags_json: String,
    expires_at_ms: Option<i64>,
    revision: i64,
    topic_key: Option<String>,
    forgotten: bool,
    superseded_by: Option<String>,
}

fn load_memory(connection: &rusqlite::Connection, id: &str) -> CoreResult<Option<MemoryRow>> {
    Ok(connection
        .query_row(
            "SELECT kind, content, content_hash, scope, repository, authority, confidence, \
             tags_json, expires_at_ms, revision, topic_key, forgotten, superseded_by \
             FROM memories WHERE id = ?1",
            params![id],
            |row| {
                Ok(MemoryRow {
                    kind: row.get(0)?,
                    content: row.get(1)?,
                    content_hash: row.get(2)?,
                    scope: row.get(3)?,
                    repository: row.get(4)?,
                    authority: row.get(5)?,
                    confidence: row.get(6)?,
                    tags_json: row.get(7)?,
                    expires_at_ms: row.get(8)?,
                    revision: row.get(9)?,
                    topic_key: row.get(10)?,
                    forgotten: row.get::<_, i64>(11)? != 0,
                    superseded_by: row.get(12)?,
                })
            },
        )
        .optional()?)
}

impl Store {
    /// Consistent pre-apply snapshot next to the store file. Snapshot failure
    /// must block the mutation.
    pub fn snapshot_now(&self, now_ms: i64) -> CoreResult<std::path::PathBuf> {
        let path = self
            .store_path
            .with_extension(format!("snapshot-{now_ms}.db"));
        crate::migration::backup::backup(&self.store_path, &path, now_ms)?;
        Ok(path)
    }

    pub fn begin_run(
        &self,
        operation: &str,
        input_hash: &str,
        plan_fingerprint: Option<&str>,
        actor: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<String> {
        let run_id = uuid::Uuid::new_v4().to_string();
        let connection = self.writer.lock().expect("writer lock");
        let store_id: String = connection.query_row(
            "SELECT store_id FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        connection.execute(
            "INSERT INTO operation_runs (run_id, operation, state, input_hash, plan_fingerprint, \
             store_id, actor, created_ms, updated_ms, finished_ms, counts_json, terminal_reason) \
             VALUES (?1, ?2, 'running', ?3, ?4, ?5, ?6, ?7, ?7, NULL, '{}', NULL)",
            params![
                run_id,
                operation,
                input_hash,
                plan_fingerprint,
                store_id,
                actor,
                now_ms
            ],
        )?;
        Ok(run_id)
    }

    pub fn finish_run(
        &self,
        run_id: &str,
        state: &str,
        counts: &BTreeMap<String, i64>,
        reason: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<()> {
        let connection = self.writer.lock().expect("writer lock");
        connection.execute(
            "UPDATE operation_runs SET state = ?2, counts_json = ?3, terminal_reason = ?4, \
             updated_ms = ?5, finished_ms = ?5 WHERE run_id = ?1",
            params![
                run_id,
                state,
                serde_json::to_string(counts)?,
                reason,
                now_ms
            ],
        )?;
        Ok(())
    }

    pub(crate) fn add_run_item(
        connection: &rusqlite::Connection,
        run_id: &str,
        index: i64,
        key: &str,
        state: &str,
        detail: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<()> {
        connection.execute(
            "INSERT INTO operation_run_items (run_id, item_index, item_key, state, detail, updated_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (run_id, item_index) DO UPDATE SET \
             state = excluded.state, detail = excluded.detail, updated_ms = excluded.updated_ms",
            params![run_id, index, key, state, detail, now_ms],
        )?;
        Ok(())
    }

    /// Run status with one bounded page of items, ordered by item index.
    pub fn run_status(&self, run_id: &str, cursor: Option<i64>, limit: u32) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let run: Option<OperationRun> = connection
            .query_row(
                "SELECT run_id, operation, state, input_hash, plan_fingerprint, store_id, actor, \
                 created_ms, updated_ms, finished_ms, counts_json, terminal_reason \
                 FROM operation_runs WHERE run_id = ?1",
                params![run_id],
                |row| {
                    Ok(OperationRun {
                        run_id: row.get(0)?,
                        operation: row.get(1)?,
                        state: row.get(2)?,
                        input_hash: row.get(3)?,
                        plan_fingerprint: row.get(4)?,
                        store_id: row.get(5)?,
                        actor: row.get(6)?,
                        created_ms: row.get(7)?,
                        updated_ms: row.get(8)?,
                        finished_ms: row.get(9)?,
                        counts: serde_json::from_str(&row.get::<_, String>(10)?)
                            .unwrap_or_default(),
                        terminal_reason: row.get(11)?,
                    })
                },
            )
            .optional()?;
        let Some(run) = run else {
            return Ok(json!({ "found": false }));
        };
        let limit = limit.clamp(1, 200);
        let start = cursor.unwrap_or(-1);
        let mut statement = connection.prepare(
            "SELECT item_index, item_key, state, detail, updated_ms FROM operation_run_items \
             WHERE run_id = ?1 AND item_index > ?2 ORDER BY item_index ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![run_id, start, (limit + 1) as i64], |row| {
            Ok(json!({
                "index": row.get::<_, i64>(0)?,
                "key": row.get::<_, String>(1)?,
                "state": row.get::<_, String>(2)?,
                "detail": row.get::<_, Option<String>>(3)?,
                "updatedMs": row.get::<_, i64>(4)?,
            }))
        })?;
        let mut items: Vec<Value> = rows.collect::<Result<_, _>>()?;
        let next_cursor = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items.last().and_then(|item| item["index"].as_i64())
        } else {
            None
        };
        Ok(json!({ "found": true, "run": run, "items": items, "nextCursor": next_cursor }))
    }

    // ---------------------------------------------------------------------
    // Correction
    // ---------------------------------------------------------------------

    /// Preview a correction and return the deterministic plan fingerprint.
    #[allow(clippy::too_many_arguments)]
    pub fn correct_preview(
        &self,
        memory_id: &str,
        content: Option<&str>,
        kind: Option<&str>,
        scope: Option<&str>,
        repository: Option<&str>,
        expires_at_ms: Option<i64>,
    ) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let store_id: String = connection.query_row(
            "SELECT store_id FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let Some(current) = load_memory(&connection, memory_id)? else {
            return Ok(json!({ "found": false }));
        };
        if current.forgotten || current.superseded_by.is_some() {
            return Err(CoreError::precondition(
                "MEMORY_NOT_ACTIVE",
                "only an active memory can be corrected",
            ));
        }
        let proposed_scope = scope.unwrap_or(&current.scope).to_string();
        let proposed_repository = if scope.is_some() || repository.is_some() {
            repository.map(str::to_string)
        } else {
            current.repository.clone()
        };
        if proposed_scope != "global" && proposed_repository.is_none() {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                "repository-scoped corrections need a repository",
            ));
        }
        let proposed_content = content.unwrap_or(&current.content).to_string();
        let proposed_kind = kind.unwrap_or(&current.kind).to_string();
        let fingerprint = fingerprint(
            "memory.correct",
            &store_id,
            &[
                memory_id.to_string(),
                current.revision.to_string(),
                current.content_hash.clone(),
                proposed_content.clone(),
                proposed_kind.clone(),
                format!(
                    "{proposed_scope}\u{1}{}",
                    proposed_repository.clone().unwrap_or_default()
                ),
                expires_at_ms
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
            ],
        );
        let suppressed: i64 = connection.query_row(
            "SELECT COUNT(*) FROM suppressions WHERE scope = ?1 \
             AND COALESCE(repository, '') = COALESCE(?2, '') AND fingerprint = ?3",
            params![
                proposed_scope,
                proposed_repository,
                crate::store::content_hash(&proposed_content)
            ],
            |row| row.get(0),
        )?;
        Ok(json!({
            "found": true,
            "fingerprint": fingerprint,
            "current": {
                "kind": current.kind,
                "content": current.content,
                "scope": current.scope,
                "repository": current.repository,
                "authority": current.authority,
                "revision": current.revision,
                "expiresAtMs": current.expires_at_ms,
            },
            "proposed": {
                "kind": proposed_kind,
                "content": proposed_content,
                "scope": proposed_scope,
                "repository": proposed_repository,
                "expiresAtMs": expires_at_ms.or(current.expires_at_ms),
                "authority": "manual",
            },
            "suppressed": suppressed > 0,
        }))
    }

    /// Apply a previewed correction: a manual replacement is created, the
    /// original is retired with lineage, and dependent derived state is
    /// invalidated atomically. Requires the exact preview fingerprint.
    #[allow(clippy::too_many_arguments)]
    pub fn correct_apply(
        &self,
        memory_id: &str,
        content: Option<&str>,
        kind: Option<&str>,
        scope: Option<&str>,
        repository: Option<&str>,
        expires_at_ms: Option<i64>,
        plan_fingerprint: &str,
        actor: Option<&str>,
        reason: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<CorrectOutcome> {
        let preview =
            self.correct_preview(memory_id, content, kind, scope, repository, expires_at_ms)?;
        if preview["found"] != true {
            return Err(CoreError::not_found(
                "MEMORY_NOT_FOUND",
                "no memory exists with that ID",
            ));
        }
        if preview["fingerprint"].as_str() != Some(plan_fingerprint) {
            return Err(CoreError::precondition(
                "PREVIEW_STALE",
                "the preview no longer matches store state; preview again",
            ));
        }
        let snapshot = self.snapshot_now(now_ms)?;
        let proposed = &preview["proposed"];
        let proposed_content = proposed["content"].as_str().unwrap_or("").to_string();
        let proposed_kind = proposed["kind"].as_str().unwrap_or("note").to_string();
        let proposed_scope = proposed["scope"].as_str().unwrap_or("repo").to_string();
        let proposed_repository = proposed["repository"].as_str().map(str::to_string);
        let proposed_expires = proposed["expiresAtMs"].as_i64();

        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let Some(current) = load_memory(&transaction, memory_id)? else {
            return Err(CoreError::not_found(
                "MEMORY_NOT_FOUND",
                "no memory exists with that ID",
            ));
        };
        let replacement_id = uuid::Uuid::new_v4().to_string();
        let base_revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let revision = base_revision + 1;
        transaction.execute(
            "INSERT INTO memories (id, kind, content, content_hash, scope, repository, authority, \
             confidence, tags_json, source_session_id, created_ms, updated_ms, expires_at_ms, \
             revision, forgotten, topic_key) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'manual', ?7, ?8, NULL, ?9, ?9, ?10, ?11, 0, ?12)",
            params![
                replacement_id,
                proposed_kind,
                proposed_content,
                crate::store::content_hash(&proposed_content),
                proposed_scope,
                proposed_repository,
                current.confidence,
                current.tags_json,
                now_ms,
                proposed_expires,
                revision,
                current.topic_key,
            ],
        )?;
        transaction.execute(
            "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, ?2, ?3, ?4)",
            params![proposed_content, proposed_kind, "", replacement_id],
        )?;
        transaction.execute(
            "UPDATE memories SET superseded_by = ?2, revision = revision + 1, updated_ms = ?3 \
             WHERE id = ?1",
            params![memory_id, replacement_id, now_ms],
        )?;
        transaction.execute(
            "DELETE FROM memory_fts WHERE memory_id = ?1",
            params![memory_id],
        )?;
        transaction.execute(
            "DELETE FROM memory_vectors WHERE memory_id = ?1",
            params![memory_id],
        )?;
        transaction.execute(
            "UPDATE memory_evidence SET retired_ms = ?2 WHERE memory_id = ?1 AND retired_ms IS NULL",
            params![memory_id, now_ms],
        )?;
        transaction.execute(
            "INSERT INTO memory_evidence (memory_id, source_id, generation, evidence_key, role, created_ms, retired_ms) \
             SELECT ?2, source_id, generation, evidence_key, role, ?3, NULL FROM memory_evidence WHERE memory_id = ?1",
            params![memory_id, replacement_id, now_ms],
        )?;
        let intent_state = if self.embedding_enabled {
            "pending"
        } else {
            "disabled"
        };
        transaction.execute(
            "INSERT INTO embedding_intents (memory_id, desired_revision, state, attempts, next_attempt_ms, \
             terminal_reason, content_hash, model_identity, updated_ms) \
             VALUES (?1, ?2, ?3, 0, NULL, NULL, ?4, ?5, ?6) \
             ON CONFLICT (memory_id) DO UPDATE SET desired_revision = excluded.desired_revision, \
             state = excluded.state, attempts = 0, next_attempt_ms = NULL, terminal_reason = NULL, \
             content_hash = excluded.content_hash, updated_ms = excluded.updated_ms",
            params![
                replacement_id,
                revision,
                intent_state,
                crate::store::content_hash(&proposed_content),
                self.embedding_identity.as_deref().unwrap_or(""),
                now_ms
            ],
        )?;
        transaction.execute(
            "UPDATE store_metadata SET memory_revision = ?1 WHERE id = 1",
            params![revision],
        )?;
        let run_id = uuid::Uuid::new_v4().to_string();
        Self::insert_run(
            &transaction,
            &run_id,
            "lore_correct",
            plan_fingerprint,
            actor,
            now_ms,
        )?;
        Self::add_run_item(
            &transaction,
            &run_id,
            0,
            memory_id,
            "replaced",
            None,
            now_ms,
        )?;
        let mut counts = BTreeMap::new();
        counts.insert("replaced".to_string(), 1);
        super::governance::ledger_insert(
            &transaction,
            "correction",
            Some(&replacement_id),
            Some(&format!("replaced {memory_id}")),
            actor,
            Some(revision),
            now_ms,
        )?;
        Self::finish_run_in(&transaction, &run_id, "complete", &counts, reason, now_ms)?;
        transaction.commit()?;
        Ok(CorrectOutcome {
            run_id,
            memory_id: replacement_id,
            replaced_id: memory_id.to_string(),
            snapshot: snapshot.display().to_string(),
            committed_revision: revision,
        })
    }

    // ---------------------------------------------------------------------
    // Purge
    // ---------------------------------------------------------------------

    /// Resolve a purge selection into concrete memory IDs. Explicit selection
    /// is required: memory IDs, a repository, or the explicit global flag.
    /// Bounded selection resolution: every selection path is capped so a
    /// broad request can never become an unbounded scan, and truncation is
    /// reported rather than silently applied.
    fn resolve_selection(
        connection: &rusqlite::Connection,
        memory_ids: &[String],
        repository: Option<&str>,
        global: bool,
        limit: Option<u32>,
    ) -> CoreResult<(Vec<String>, bool, i64)> {
        let cap = limit
            .unwrap_or(PURGE_SELECTION_MAX)
            .clamp(1, PURGE_SELECTION_MAX) as usize;
        if !memory_ids.is_empty() {
            let total = memory_ids.len() as i64;
            let ids: Vec<String> = memory_ids.iter().take(cap).cloned().collect();
            let truncated = total > cap as i64;
            return Ok((ids, truncated, total));
        }
        let (sql, params): (&str, Vec<rusqlite::types::Value>) = if global {
            (
                "SELECT id FROM memories WHERE scope = 'global' AND forgotten = 0 \
                 AND superseded_by IS NULL ORDER BY id ASC",
                Vec::new(),
            )
        } else if let Some(repository) = repository {
            (
                "SELECT id FROM memories WHERE repository = ?1 AND forgotten = 0 \
                 AND superseded_by IS NULL ORDER BY id ASC",
                vec![repository.to_string().into()],
            )
        } else {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                "purge requires explicit memoryIds, a repository, or global selection",
            ));
        };
        let (count_sql, rows_sql) = (sql.replace("SELECT id", "SELECT COUNT(*)"), sql);
        let total: i64 = connection.query_row(
            &count_sql,
            rusqlite::params_from_iter(params.iter()),
            |row| row.get(0),
        )?;
        let mut statement = connection.prepare(&format!("{rows_sql} LIMIT ?"))?;
        let mut values = params;
        values.push((cap as i64).into());
        let ids: Vec<String> = statement
            .query_map(rusqlite::params_from_iter(values.iter()), |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<_, _>>()?;
        Ok((ids, total > cap as i64, total))
    }

    /// Preview a purge with its dependency closure. Explicit selection and the
    /// dependency acknowledgement are required before apply.
    pub fn purge_preview(
        &self,
        memory_ids: &[String],
        repository: Option<&str>,
        global: bool,
        limit: Option<u32>,
        include_dependent_aggregates: bool,
    ) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let store_id: String = connection.query_row(
            "SELECT store_id FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let (ids, truncated, total_matched) =
            Self::resolve_selection(&connection, memory_ids, repository, global, limit)?;
        let mut revisions = Vec::new();
        let (mut evidence_links, mut vectors) = (0i64, 0i64);
        // Aggregate collection is the expensive half of the preview; callers
        // that only need the selection can omit it.
        if include_dependent_aggregates {
            for id in &ids {
                let link_count: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM memory_evidence WHERE memory_id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                evidence_links += link_count;
                let vector_count: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM memory_vectors WHERE memory_id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                vectors += vector_count;
                let revision: Option<i64> = connection
                    .query_row(
                        "SELECT revision FROM memories WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(revision) = revision {
                    revisions.push(format!("{id}:{revision}"));
                }
            }
            revisions.sort();
        }
        let fingerprint = fingerprint(
            "memory.purge",
            &store_id,
            &[
                ids.join(","),
                revisions.join(","),
                evidence_links.to_string(),
                vectors.to_string(),
                include_dependent_aggregates.to_string(),
                truncated.to_string(),
            ],
        );
        Ok(json!({
            "fingerprint": fingerprint,
            "memoryIds": ids,
            "totalMatched": total_matched,
            "selectionTruncated": truncated,
            "selectionLimit": limit.unwrap_or(PURGE_SELECTION_MAX),
            "dependentAggregates": if include_dependent_aggregates { "complete" } else { "omitted" },
            "counts": { "memories": ids.len(), "evidenceLinks": evidence_links, "vectors": vectors },
            "preserves": ["scoped suppression", "raw sources", "backups"],
        }))
    }

    /// Apply a previewed purge: forgotten with durable scoped suppression,
    /// derived vectors removed, evidence retained as provenance.
    #[allow(clippy::too_many_arguments)]
    /// derived vectors removed, evidence retained as provenance.
    pub fn purge_apply(
        &self,
        memory_ids: &[String],
        repository: Option<&str>,
        global: bool,
        limit: Option<u32>,
        include_dependent_aggregates: bool,
        plan_fingerprint: &str,
        actor: Option<&str>,
        reason: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<PurgeOutcome> {
        let preview = self.purge_preview(
            memory_ids,
            repository,
            global,
            limit,
            include_dependent_aggregates,
        )?;
        if preview["fingerprint"].as_str() != Some(plan_fingerprint) {
            return Err(CoreError::precondition(
                "PREVIEW_STALE",
                "the preview no longer matches store state; preview again",
            ));
        }
        let ids: Vec<String> = preview["memoryIds"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let snapshot = self.snapshot_now(now_ms)?;
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let run_id = uuid::Uuid::new_v4().to_string();
        Self::insert_run(
            &transaction,
            &run_id,
            "lore_purge",
            plan_fingerprint,
            actor,
            now_ms,
        )?;
        let mut purged = 0u64;
        for (index, id) in ids.iter().enumerate() {
            let Some(row) = load_memory(&transaction, id)? else {
                Self::add_run_item(
                    &transaction,
                    &run_id,
                    index as i64,
                    id,
                    "skipped",
                    Some("not_found"),
                    now_ms,
                )?;
                continue;
            };
            if row.forgotten {
                Self::add_run_item(
                    &transaction,
                    &run_id,
                    index as i64,
                    id,
                    "skipped",
                    Some("already_forgotten"),
                    now_ms,
                )?;
                continue;
            }
            revision += 1;
            transaction.execute(
                "UPDATE memories SET forgotten = 1, content = '', revision = ?2, updated_ms = ?3 \
                 WHERE id = ?1",
                params![id, revision, now_ms],
            )?;
            transaction.execute("DELETE FROM memory_fts WHERE memory_id = ?1", params![id])?;
            transaction.execute(
                "DELETE FROM memory_vectors WHERE memory_id = ?1",
                params![id],
            )?;
            transaction.execute(
                "DELETE FROM embedding_intents WHERE memory_id = ?1",
                params![id],
            )?;
            transaction.execute(
                "INSERT INTO suppressions (memory_id, scope, repository, fingerprint, reason, revision, created_ms, state) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active') \
                 ON CONFLICT (memory_id, scope, COALESCE(repository, ''), fingerprint) DO NOTHING",
                params![
                    id,
                    row.scope,
                    row.repository,
                    row.content_hash,
                    reason.unwrap_or("purged"),
                    revision,
                    now_ms
                ],
            )?;
            Self::add_run_item(
                &transaction,
                &run_id,
                index as i64,
                id,
                "purged",
                None,
                now_ms,
            )?;
            purged += 1;
        }
        transaction.execute(
            "UPDATE store_metadata SET memory_revision = ?1, active_memories = \
             (SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL), \
             forgotten_memories = (SELECT COUNT(*) FROM memories WHERE forgotten = 1) WHERE id = 1",
            params![revision],
        )?;
        let mut counts = BTreeMap::new();
        counts.insert("purged".to_string(), purged as i64);
        counts.insert("selected".to_string(), ids.len() as i64);
        super::governance::ledger_insert(
            &transaction,
            "purge",
            None,
            Some(&format!("purged {purged} memories")),
            actor,
            Some(revision),
            now_ms,
        )?;
        Self::finish_run_in(&transaction, &run_id, "complete", &counts, reason, now_ms)?;
        transaction.commit()?;
        Ok(PurgeOutcome {
            run_id,
            purged,
            snapshot: snapshot.display().to_string(),
            committed_revision: revision,
        })
    }

    // ---------------------------------------------------------------------
    // Scope override and audit
    // ---------------------------------------------------------------------

    /// Preview a scope override: set or clear explicit scope on memory rows.
    pub fn scope_override_preview(
        &self,
        memory_ids: &[String],
        scope: Option<&str>,
        repository: Option<&str>,
        clear: bool,
    ) -> CoreResult<Value> {
        if memory_ids.is_empty() {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                "scope override requires explicit memoryIds",
            ));
        }
        if clear && (scope.is_some() || repository.is_some()) {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                "clear cannot be combined with an explicit scope",
            ));
        }
        if !clear {
            let scope = scope.unwrap_or("");
            if !matches!(scope, "global" | "repo" | "transferable") {
                return Err(CoreError::invalid(
                    "ADMIN_ARGUMENT_INVALID",
                    "scope must be global, repo or transferable",
                ));
            }
            if scope != "global" && repository.is_none() {
                return Err(CoreError::invalid(
                    "ADMIN_ARGUMENT_INVALID",
                    "scoped overrides need a repository",
                ));
            }
        }
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let store_id: String = connection.query_row(
            "SELECT store_id FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let mut entries = Vec::new();
        let mut revisions = Vec::new();
        for id in memory_ids {
            let Some(row) = load_memory(&connection, id)? else {
                entries.push(json!({ "id": id, "found": false }));
                continue;
            };
            revisions.push(format!("{id}:{}", row.revision));
            entries.push(json!({
                "id": id,
                "found": true,
                "currentScope": row.scope,
                "currentRepository": row.repository,
                "forgotten": row.forgotten,
                "supersededBy": row.superseded_by,
            }));
        }
        revisions.sort();
        let fingerprint = fingerprint(
            if clear {
                "memory.scope.clear"
            } else {
                "memory.scope.set"
            },
            &store_id,
            &[
                memory_ids.join(","),
                revisions.join(","),
                scope.unwrap_or("").to_string(),
                repository.unwrap_or("").to_string(),
            ],
        );
        Ok(json!({
            "fingerprint": fingerprint,
            "entries": entries,
            "clear": clear,
            "scope": scope,
            "repository": repository,
        }))
    }

    /// Apply a previewed scope override, recording actor/reason in the audit
    /// ledger and invalidating vector eligibility immediately.
    #[allow(clippy::too_many_arguments)]
    pub fn scope_override_apply(
        &self,
        memory_ids: &[String],
        scope: Option<&str>,
        repository: Option<&str>,
        clear: bool,
        plan_fingerprint: &str,
        actor: &str,
        reason: &str,
        now_ms: i64,
    ) -> CoreResult<ScopeOutcome> {
        let preview = self.scope_override_preview(memory_ids, scope, repository, clear)?;
        if preview["fingerprint"].as_str() != Some(plan_fingerprint) {
            return Err(CoreError::precondition(
                "PREVIEW_STALE",
                "the preview no longer matches store state; preview again",
            ));
        }
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let run_id = uuid::Uuid::new_v4().to_string();
        Self::insert_run(
            &transaction,
            &run_id,
            if clear {
                "memory_scope_clear"
            } else {
                "memory_scope_override"
            },
            plan_fingerprint,
            Some(actor),
            now_ms,
        )?;
        let mut updated = 0u64;
        for (index, id) in memory_ids.iter().enumerate() {
            let Some(row) = load_memory(&transaction, id)? else {
                Self::add_run_item(
                    &transaction,
                    &run_id,
                    index as i64,
                    id,
                    "skipped",
                    Some("not_found"),
                    now_ms,
                )?;
                continue;
            };
            let (next_scope, next_repository) = if clear {
                // Recompute automatic scope from verified evidence: without
                // verified repository identity the row stays unresolved (repo
                // with no repository is not allowed), so this intentionally
                // falls back to the previous scope when nothing is verifiable.
                (row.scope.clone(), row.repository.clone())
            } else {
                (
                    scope.unwrap_or("repo").to_string(),
                    repository
                        .map(str::to_string)
                        .filter(|_| scope != Some("global")),
                )
            };
            revision += 1;
            transaction.execute(
                "UPDATE memories SET scope = ?2, repository = ?3, revision = ?4, updated_ms = ?5 \
                 WHERE id = ?1",
                params![id, next_scope, next_repository, revision, now_ms],
            )?;
            transaction.execute(
                "DELETE FROM memory_vectors WHERE memory_id = ?1",
                params![id],
            )?;
            transaction.execute(
                "UPDATE embedding_intents SET state = CASE WHEN state = 'disabled' THEN 'disabled' ELSE 'pending' END, \
                 attempts = 0, next_attempt_ms = NULL, terminal_reason = NULL, updated_ms = ?2 \
                 WHERE memory_id = ?1",
                params![id, now_ms],
            )?;
            transaction.execute(
                "INSERT INTO scope_override_audit (memory_id, previous_scope, previous_repository, \
                 scope, repository, actor, reason, created_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    row.scope,
                    row.repository,
                    next_scope,
                    next_repository,
                    actor,
                    reason,
                    now_ms
                ],
            )?;
            Self::add_run_item(
                &transaction,
                &run_id,
                index as i64,
                id,
                "updated",
                None,
                now_ms,
            )?;
            updated += 1;
        }
        transaction.execute(
            "UPDATE store_metadata SET memory_revision = ?1 WHERE id = 1",
            params![revision],
        )?;
        let mut counts = BTreeMap::new();
        counts.insert("updated".to_string(), updated as i64);
        super::governance::ledger_insert(
            &transaction,
            "scope_change",
            None,
            Some(&format!("override applied to {updated} memories")),
            Some(actor),
            Some(revision),
            now_ms,
        )?;
        Self::finish_run_in(
            &transaction,
            &run_id,
            "complete",
            &counts,
            Some(reason),
            now_ms,
        )?;
        transaction.commit()?;
        Ok(ScopeOutcome {
            run_id,
            updated,
            committed_revision: revision,
        })
    }

    /// Scope override audit ledger, newest first, keyset by audit id.
    pub fn scope_audit(&self, cursor: Option<i64>, limit: u32) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let limit = limit.clamp(1, 200);
        let start = cursor.unwrap_or(i64::MAX);
        let mut statement = connection.prepare(
            "SELECT id, memory_id, previous_scope, previous_repository, scope, repository, actor, \
             reason, created_ms FROM scope_override_audit WHERE id < ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![start, (limit + 1) as i64], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "memoryId": row.get::<_, String>(1)?,
                "previousScope": row.get::<_, Option<String>>(2)?,
                "previousRepository": row.get::<_, Option<String>>(3)?,
                "scope": row.get::<_, Option<String>>(4)?,
                "repository": row.get::<_, Option<String>>(5)?,
                "actor": row.get::<_, Option<String>>(6)?,
                "reason": row.get::<_, Option<String>>(7)?,
                "createdMs": row.get::<_, i64>(8)?,
            }))
        })?;
        let mut entries: Vec<Value> = rows.collect::<Result<_, _>>()?;
        let next_cursor = if entries.len() > limit as usize {
            entries.truncate(limit as usize);
            entries.last().and_then(|entry| entry["id"].as_i64())
        } else {
            None
        };
        Ok(json!({ "entries": entries, "nextCursor": next_cursor, "observedAt": now_ms() }))
    }

    // ---------------------------------------------------------------------
    // Run helpers used inside transactions
    // ---------------------------------------------------------------------

    pub(crate) fn insert_run(
        connection: &rusqlite::Connection,
        run_id: &str,
        operation: &str,
        plan_fingerprint: &str,
        actor: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<()> {
        let store_id: String = connection.query_row(
            "SELECT store_id FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        connection.execute(
            "INSERT INTO operation_runs (run_id, operation, state, input_hash, plan_fingerprint, \
             store_id, actor, created_ms, updated_ms, finished_ms, counts_json, terminal_reason) \
             VALUES (?1, ?2, 'running', ?3, ?3, ?4, ?5, ?6, ?6, NULL, '{}', NULL)",
            params![
                run_id,
                operation,
                crate::policy::sha256_hex(plan_fingerprint.as_bytes()),
                store_id,
                actor,
                now_ms
            ],
        )?;
        Ok(())
    }

    pub(crate) fn finish_run_in(
        connection: &rusqlite::Connection,
        run_id: &str,
        state: &str,
        counts: &BTreeMap<String, i64>,
        reason: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<()> {
        connection.execute(
            "UPDATE operation_runs SET state = ?2, counts_json = ?3, terminal_reason = ?4, \
             updated_ms = ?5, finished_ms = ?5 WHERE run_id = ?1",
            params![
                run_id,
                state,
                serde_json::to_string(counts)?,
                reason,
                now_ms
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_are_deterministic_and_input_sensitive() {
        let first = fingerprint("op", "store", &["a".to_string(), "b".to_string()]);
        assert_eq!(
            first,
            fingerprint("op", "store", &["a".to_string(), "b".to_string()])
        );
        assert_ne!(
            first,
            fingerprint("op", "store", &["a".to_string(), "c".to_string()])
        );
        assert_ne!(
            first,
            fingerprint("op2", "store", &["a".to_string(), "b".to_string()])
        );
        assert_ne!(
            first,
            fingerprint("op", "store2", &["a".to_string(), "b".to_string()])
        );
    }
}

// ---------------------------------------------------------------------
// Onboarding, maintenance and reflection
// ---------------------------------------------------------------------

/// Input for the onboarding identity slots.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardInput {
    pub user_name: Option<String>,
    pub assistant_name: Option<String>,
    pub voice: Option<String>,
    pub warmth: Option<String>,
    pub humor: Option<String>,
    pub humor_frequency: Option<String>,
    pub collaborative: Option<bool>,
    pub use_name_naturally: Option<bool>,
}

impl OnboardInput {
    fn is_empty(&self) -> bool {
        self.user_name.is_none()
            && self.assistant_name.is_none()
            && self.voice.is_none()
            && self.warmth.is_none()
            && self.humor.is_none()
            && self.humor_frequency.is_none()
            && self.collaborative.is_none()
            && self.use_name_naturally.is_none()
    }
}

/// One onboarded identity slot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardSlot {
    pub memory_id: String,
    pub created: bool,
}

/// Outcome of an onboarding apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardOutcome {
    pub assistant: Option<OnboardSlot>,
    pub user: Option<OnboardSlot>,
    pub committed_revision: i64,
}

/// One maintenance task result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceTask {
    pub name: String,
    pub affected: u64,
}

/// Outcome of a maintenance run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceOutcome {
    pub dry_run: bool,
    pub tasks: Vec<MaintenanceTask>,
    pub run_id: Option<String>,
    pub committed_revision: i64,
}

/// Outcome of a reflection build.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectOutcome {
    pub text: String,
    pub memory_ids: Vec<String>,
    pub persisted: Option<String>,
    pub committed_revision: i64,
}

/// Maximum rows one selection-based purge may touch.
pub const PURGE_SELECTION_MAX: u32 = 5_000;

/// Registered maintenance task names.
pub const MAINTENANCE_TASKS: [&str; 3] = [
    "expire_memories",
    "retry_stale_extraction",
    "reap_embedding_jobs",
];

pub(super) fn queue_embedding(
    transaction: &rusqlite::Transaction<'_>,
    memory_id: &str,
    revision: i64,
    content_hash: &str,
    embedding_enabled: bool,
    embedding_identity: Option<&str>,
    now_ms: i64,
) -> CoreResult<()> {
    let state = if embedding_enabled {
        "pending"
    } else {
        "disabled"
    };
    transaction.execute(
        "INSERT INTO embedding_intents \
         (memory_id, desired_revision, state, attempts, next_attempt_ms, terminal_reason, \
          content_hash, model_identity, updated_ms) \
         VALUES (?1, ?2, ?3, 0, NULL, NULL, ?4, ?5, ?6) \
         ON CONFLICT (memory_id) DO UPDATE SET \
          desired_revision = excluded.desired_revision, state = excluded.state, attempts = 0, \
          next_attempt_ms = NULL, terminal_reason = NULL, content_hash = excluded.content_hash, \
          model_identity = excluded.model_identity, updated_ms = excluded.updated_ms",
        params![
            memory_id,
            revision,
            state,
            content_hash,
            embedding_identity.unwrap_or(""),
            now_ms
        ],
    )?;
    Ok(())
}

/// Insert or update a global identity memory keyed by `topic_key`.
///
/// Returns `(memory_id, created, changed)`; a repeat onboard with identical
/// content is a no-op that keeps the same memory id.
#[allow(clippy::too_many_arguments)]
fn upsert_identity(
    transaction: &rusqlite::Transaction<'_>,
    kind: &str,
    topic_key: &str,
    content: &str,
    embedding_enabled: bool,
    embedding_identity: Option<&str>,
    revision: &mut i64,
    now_ms: i64,
) -> CoreResult<(String, bool, bool)> {
    let content_hash = crate::policy::sha256_hex(content.as_bytes());
    let existing: Option<(String, String)> = transaction
        .query_row(
            "SELECT id, content_hash FROM memories WHERE kind = ?1 AND scope = 'global' \
             AND topic_key = ?2 AND forgotten = 0 AND superseded_by IS NULL \
             ORDER BY revision DESC LIMIT 1",
            params![kind, topic_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((memory_id, stored_hash)) = existing {
        if stored_hash == content_hash {
            return Ok((memory_id, false, false));
        }
        *revision += 1;
        transaction.execute(
            "UPDATE memories SET content = ?2, content_hash = ?3, revision = ?4, updated_ms = ?5 \
             WHERE id = ?1",
            params![memory_id, content, content_hash, *revision, now_ms],
        )?;
        let updated = transaction.execute(
            "UPDATE memory_fts SET content = ?1, kind = ?2 WHERE memory_id = ?3",
            params![content, kind, memory_id],
        )?;
        if updated == 0 {
            transaction.execute(
                "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, ?2, '', ?3)",
                params![content, kind, memory_id],
            )?;
        }
        queue_embedding(
            transaction,
            &memory_id,
            *revision,
            &content_hash,
            embedding_enabled,
            embedding_identity,
            now_ms,
        )?;
        return Ok((memory_id, false, true));
    }

    *revision += 1;
    let memory_id = uuid::Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO memories (id, kind, content, content_hash, scope, repository, authority, \
         confidence, tags_json, source_session_id, created_ms, updated_ms, expires_at_ms, \
         revision, forgotten, topic_key) \
         VALUES (?1, ?2, ?3, ?4, 'global', NULL, 'manual', 1.0, '[]', NULL, ?5, ?5, NULL, ?6, 0, ?7)",
        params![memory_id, kind, content, content_hash, now_ms, *revision, topic_key],
    )?;
    transaction.execute(
        "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, ?2, '', ?3)",
        params![content, kind, memory_id],
    )?;
    queue_embedding(
        transaction,
        &memory_id,
        *revision,
        &content_hash,
        embedding_enabled,
        embedding_identity,
        now_ms,
    )?;
    Ok((memory_id, true, true))
}

impl Store {
    /// Apply onboarding: the assistant identity and style profile, and the
    /// user's preferred name, as global memories in stable slots.
    pub fn onboard_apply(&self, input: &OnboardInput, now_ms: i64) -> CoreResult<OnboardOutcome> {
        if input.is_empty() {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                "onboarding needs at least one identity field",
            ));
        }
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;

        let assistant = if input.assistant_name.is_some()
            || input.voice.is_some()
            || input.warmth.is_some()
            || input.humor.is_some()
            || input.humor_frequency.is_some()
            || input.collaborative.is_some()
            || input.use_name_naturally.is_some()
        {
            let mut lines: Vec<String> = Vec::new();
            if let Some(name) = &input.assistant_name {
                lines.push(format!("The assistant's name is {name}."));
            }
            if let Some(voice) = &input.voice {
                lines.push(format!("Speak with a {voice} voice."));
            }
            if let Some(warmth) = &input.warmth {
                lines.push(format!("Warmth: {warmth}."));
            }
            match (&input.humor, &input.humor_frequency) {
                (Some(humor), Some(frequency)) => {
                    lines.push(format!("Humor: {humor}, {frequency}."));
                }
                (Some(humor), None) => lines.push(format!("Humor: {humor}.")),
                (None, Some(frequency)) => lines.push(format!("Humor frequency: {frequency}.")),
                (None, None) => {}
            }
            if input.collaborative == Some(true) {
                lines.push("Default to a collaborative teammate posture.".to_string());
            }
            if let Some(true) = input.use_name_naturally {
                lines.push("Use the user's preferred name naturally when helpful.".to_string());
            }
            let content = lines.join(" ");
            let (memory_id, created, changed) = upsert_identity(
                &transaction,
                "assistant_identity",
                "identity.assistant",
                &content,
                self.embedding_enabled,
                self.embedding_identity.as_deref(),
                &mut revision,
                now_ms,
            )?;
            Some(OnboardSlot {
                memory_id,
                created: created || changed,
            })
        } else {
            None
        };

        let user = if let Some(name) = &input.user_name {
            let content = format!("The user's preferred name is {name}.");
            let (memory_id, created, changed) = upsert_identity(
                &transaction,
                "user_identity",
                "identity.user",
                &content,
                self.embedding_enabled,
                self.embedding_identity.as_deref(),
                &mut revision,
                now_ms,
            )?;
            Some(OnboardSlot {
                memory_id,
                created: created || changed,
            })
        } else {
            None
        };

        if assistant.is_some() || user.is_some() {
            transaction.execute(
                "UPDATE store_metadata SET memory_revision = ?1, active_memories = \
                 (SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL) \
                 WHERE id = 1",
                params![revision],
            )?;
        }
        transaction.commit()?;
        Ok(OnboardOutcome {
            assistant,
            user,
            committed_revision: revision,
        })
    }

    /// Run registered maintenance tasks. Dry runs roll the transaction back.
    pub fn maintenance_run(
        &self,
        tasks: &[String],
        dry_run: bool,
        now_ms: i64,
    ) -> CoreResult<MaintenanceOutcome> {
        let requested: Vec<String> = if tasks.is_empty() {
            MAINTENANCE_TASKS
                .iter()
                .map(|name| name.to_string())
                .collect()
        } else {
            tasks.to_vec()
        };
        for task in &requested {
            if !MAINTENANCE_TASKS.contains(&task.as_str()) {
                return Err(CoreError::invalid(
                    "ADMIN_ARGUMENT_INVALID",
                    format!("unknown maintenance task: {task}"),
                ));
            }
        }

        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let mut results = Vec::new();

        if requested.iter().any(|task| task == "expire_memories") {
            let rows: Vec<(String, String, Option<String>, String)> = {
                let mut statement = transaction.prepare(
                    "SELECT id, scope, repository, content_hash FROM memories \
                     WHERE forgotten = 0 AND superseded_by IS NULL AND expires_at_ms IS NOT NULL \
                     AND expires_at_ms <= ?1 LIMIT 500",
                )?;
                let mapped = statement.query_map(params![now_ms], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?;
                mapped.collect::<Result<Vec<_>, _>>()?
            };
            let mut affected = 0u64;
            if !dry_run {
                for (memory_id, scope, repository, content_hash) in &rows {
                    revision += 1;
                    transaction.execute(
                        "UPDATE memories SET forgotten = 1, content = '', revision = ?2, updated_ms = ?3 \
                         WHERE id = ?1",
                        params![memory_id, revision, now_ms],
                    )?;
                    transaction.execute(
                        "DELETE FROM memory_fts WHERE memory_id = ?1",
                        params![memory_id],
                    )?;
                    transaction.execute(
                        "DELETE FROM memory_vectors WHERE memory_id = ?1",
                        params![memory_id],
                    )?;
                    transaction.execute(
                        "DELETE FROM embedding_intents WHERE memory_id = ?1",
                        params![memory_id],
                    )?;
                    transaction.execute(
                        "INSERT INTO suppressions (memory_id, scope, repository, fingerprint, reason, revision, created_ms, state) \
                         VALUES (?1, ?2, ?3, ?4, 'expired', ?5, ?6, 'active') \
                         ON CONFLICT (memory_id, scope, COALESCE(repository, ''), fingerprint) DO NOTHING",
                        params![memory_id, scope, repository, content_hash, revision, now_ms],
                    )?;
                    affected += 1;
                }
            } else {
                affected = rows.len() as u64;
            }
            results.push(MaintenanceTask {
                name: "expire_memories".to_string(),
                affected,
            });
        }

        if requested
            .iter()
            .any(|task| task == "retry_stale_extraction")
        {
            let due = "state = 'retry_wait' AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?1)";
            let affected = if dry_run {
                transaction.query_row(
                    &format!("SELECT COUNT(*) FROM extraction_intents WHERE {due}"),
                    params![now_ms],
                    |row| row.get::<_, i64>(0),
                )? as u64
            } else {
                transaction.execute(
                    &format!(
                        "UPDATE extraction_intents SET state = 'pending', next_attempt_ms = NULL, \
                         lease_token = NULL, lease_owner = NULL, lease_expires_ms = NULL, updated_ms = ?1 \
                         WHERE {due}"
                    ),
                    params![now_ms],
                )? as u64
            };
            results.push(MaintenanceTask {
                name: "retry_stale_extraction".to_string(),
                affected,
            });
        }

        if requested.iter().any(|task| task == "reap_embedding_jobs") {
            let affected = if dry_run {
                transaction.query_row(
                    "SELECT COUNT(*) FROM embedding_jobs WHERE state = 'running' \
                     AND lease_expires_ms IS NOT NULL AND lease_expires_ms <= ?1",
                    params![now_ms],
                    |row| row.get::<_, i64>(0),
                )? as u64
            } else {
                transaction.execute(
                    "UPDATE embedding_jobs SET state = 'queued', lease_token = NULL, \
                     lease_owner = NULL, lease_expires_ms = NULL, updated_ms = ?1 \
                     WHERE state = 'running' AND lease_expires_ms IS NOT NULL AND lease_expires_ms <= ?1",
                    params![now_ms],
                )? as u64
            };
            results.push(MaintenanceTask {
                name: "reap_embedding_jobs".to_string(),
                affected,
            });
        }

        let mut run_id = None;
        if !dry_run {
            let run = uuid::Uuid::new_v4().to_string();
            let mut sorted = requested.clone();
            sorted.sort();
            let plan = fingerprint("lore_maintenance", "", &sorted);
            Self::insert_run(&transaction, &run, "lore_maintenance", &plan, None, now_ms)?;
            let mut counts = BTreeMap::new();
            for task in &results {
                counts.insert(task.name.clone(), task.affected as i64);
            }
            Self::finish_run_in(&transaction, &run, "complete", &counts, None, now_ms)?;
            run_id = Some(run);
            transaction.execute(
                "UPDATE store_metadata SET memory_revision = ?1, active_memories = \
                 (SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL), \
                 forgotten_memories = (SELECT COUNT(*) FROM memories WHERE forgotten = 1) WHERE id = 1",
                params![revision],
            )?;
            transaction.commit()?;
        } else {
            transaction.rollback()?;
        }
        Ok(MaintenanceOutcome {
            dry_run,
            tasks: results,
            run_id,
            committed_revision: revision,
        })
    }

    /// Build a deterministic reflection digest over recent in-scope memories.
    /// With `persist`, the digest is stored as an inferred `reflection` memory
    /// whose tags list the represented memory ids. The query text itself is
    /// never persisted.
    pub fn reflect(
        &self,
        query: Option<&str>,
        repository: Option<&str>,
        limit: u32,
        persist: bool,
        now_ms: i64,
    ) -> CoreResult<ReflectOutcome> {
        let limit = limit.clamp(1, 50) as i64;
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

        let mut clauses = vec!["m.forgotten = 0", "m.superseded_by IS NULL"];
        let mut binds: Vec<rusqlite::types::Value> = Vec::new();
        let mut from = "memories m".to_string();
        if let Some(query) = query.map(str::trim).filter(|value| !value.is_empty()) {
            let terms = crate::retrieval::extract_terms(query);
            if terms.is_empty() {
                return Ok(ReflectOutcome {
                    text: String::new(),
                    memory_ids: Vec::new(),
                    persisted: None,
                    committed_revision: transaction.query_row(
                        "SELECT memory_revision FROM store_metadata WHERE id = 1",
                        [],
                        |row| row.get(0),
                    )?,
                });
            }
            from = "memory_fts JOIN memories m ON m.id = memory_fts.memory_id".to_string();
            clauses.push("memory_fts MATCH ?");
            binds.push(rusqlite::types::Value::Text(crate::retrieval::fts_query(
                &terms,
            )));
        }
        if let Some(repository) = repository {
            clauses.push("(m.scope IN ('global', 'transferable') OR m.repository = ?)");
            binds.push(rusqlite::types::Value::Text(repository.to_string()));
        } else {
            clauses.push("m.scope IN ('global', 'transferable')");
        }
        binds.push(rusqlite::types::Value::Integer(limit));
        let sql = format!(
            "SELECT m.id, m.kind, m.content FROM {from} WHERE {} \
             ORDER BY m.updated_ms DESC, m.id ASC LIMIT ?",
            clauses.join(" AND ")
        );
        let rows: Vec<(String, String, String)> = {
            let mut statement = transaction.prepare(&sql)?;
            let mapped = statement.query_map(rusqlite::params_from_iter(binds), |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
            mapped.collect::<Result<Vec<_>, _>>()?
        };
        if rows.is_empty() {
            let revision: i64 = transaction.query_row(
                "SELECT memory_revision FROM store_metadata WHERE id = 1",
                [],
                |row| row.get(0),
            )?;
            return Ok(ReflectOutcome {
                text: String::new(),
                memory_ids: Vec::new(),
                persisted: None,
                committed_revision: revision,
            });
        }

        let mut text = String::from("# Reflection\n\n");
        for (_, kind, content) in &rows {
            let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
            let excerpt = if collapsed.chars().count() > 240 {
                let head: String = collapsed.chars().take(240).collect();
                format!("{head}...")
            } else {
                collapsed
            };
            text.push_str(&format!("- [{kind}] {excerpt}\n"));
        }

        let mut revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let mut persisted = None;
        if persist {
            revision += 1;
            let memory_id = uuid::Uuid::new_v4().to_string();
            let content_hash = crate::policy::sha256_hex(text.as_bytes());
            let mut tags: Vec<String> = vec!["reflection".to_string()];
            for (id, _, _) in rows.iter().take(20) {
                tags.push(format!("from:{id}"));
            }
            let tags_json = serde_json::to_string(&tags)?;
            let (scope, repository) = match repository {
                Some(repository) => ("repo", Some(repository)),
                None => ("global", None),
            };
            transaction.execute(
                "INSERT INTO memories (id, kind, content, content_hash, scope, repository, authority, \
                 confidence, tags_json, source_session_id, created_ms, updated_ms, expires_at_ms, \
                 revision, forgotten) \
                 VALUES (?1, 'reflection', ?2, ?3, ?4, ?5, 'inferred', 0.6, ?6, NULL, ?7, ?7, NULL, ?8, 0)",
                params![memory_id, text, content_hash, scope, repository, tags_json, now_ms, revision],
            )?;
            transaction.execute(
                "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, 'reflection', ?2, ?3)",
                params![text, tags.join(" "), memory_id],
            )?;
            queue_embedding(
                &transaction,
                &memory_id,
                revision,
                &content_hash,
                self.embedding_enabled,
                self.embedding_identity.as_deref(),
                now_ms,
            )?;
            transaction.execute(
                "UPDATE store_metadata SET memory_revision = ?1, active_memories = \
                 (SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL) WHERE id = 1",
                params![revision],
            )?;
            persisted = Some(memory_id);
        }
        transaction.commit()?;
        Ok(ReflectOutcome {
            text,
            memory_ids: rows.iter().map(|(id, _, _)| id.clone()).collect(),
            persisted,
            committed_revision: revision,
        })
    }
}
