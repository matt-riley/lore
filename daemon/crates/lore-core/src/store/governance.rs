//! Governance records: improvement backlog, evolution ledger, intent journal,
//! the review gate, bounded repair and frozen-case replay.
//!
//! All reads are bounded and keyset-paged; writes are explicit, attributed
//! and idempotent where the caller supplies a stable id.

use std::collections::{BTreeMap, HashSet};

use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{CoreError, CoreResult};
use crate::extraction::{TurnInput, extract};
use crate::store::Store;

/// Default complete-source limit: 32 MiB of observed source bytes.
pub const REPAIR_SOURCE_LIMIT_BYTES: u64 = 32 * 1024 * 1024;

const BACKLOG_STATES: [&str; 4] = ["proposed", "accepted", "rejected", "done"];
const JOURNAL_STATES: [&str; 5] = ["open", "doing", "blocked", "done", "cancelled"];
const LEDGER_TYPES: [&str; 9] = [
    "correction",
    "purge",
    "scope_change",
    "migration",
    "import",
    "repair",
    "replay",
    "onboard",
    "note",
];

/// Append one evolution-ledger entry inside an existing transaction.
pub(super) fn ledger_insert(
    connection: &rusqlite::Connection,
    entry_type: &str,
    subject: Option<&str>,
    detail: Option<&str>,
    actor: Option<&str>,
    memory_revision: Option<i64>,
    now_ms: i64,
) -> CoreResult<()> {
    connection.execute(
        "INSERT INTO evolution_ledger (entry_type, subject, detail, actor, memory_revision, created_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![entry_type, subject, detail, actor, memory_revision, now_ms],
    )?;
    Ok(())
}

fn page_bounds(limit: u32) -> i64 {
    limit.clamp(1, 200) as i64
}

fn revision(connection: &rusqlite::Connection) -> CoreResult<i64> {
    Ok(connection.query_row(
        "SELECT memory_revision FROM store_metadata WHERE id = 1",
        [],
        |row| row.get(0),
    )?)
}

impl Store {
    // -----------------------------------------------------------------
    // Improvement backlog
    // -----------------------------------------------------------------

    /// List backlog items, newest first, with an optional state filter.
    pub fn backlog_list(
        &self,
        cursor: Option<&str>,
        limit: u32,
        state: Option<&str>,
    ) -> CoreResult<Value> {
        if let Some(state) = state
            && !BACKLOG_STATES.contains(&state)
        {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                format!("unknown backlog state: {state}"),
            ));
        }
        let start = cursor.unwrap_or(i64::MAX.to_string().as_str()).to_string();
        let start: i64 = start.parse().map_err(|_| {
            CoreError::invalid("ADMIN_ARGUMENT_INVALID", "cursor must be a decimal id")
        })?;
        let limit = page_bounds(limit);
        let connection = self.reader().lock().expect("reader lock");
        let mut statement = connection.prepare(
            "SELECT id, kind, title, detail, state, source, evidence_json, run_id, created_ms, updated_ms \
             FROM improvement_backlog WHERE updated_ms < ?1 AND updated_ms <= ?1 AND (?2 IS NULL OR state = ?2) \
             ORDER BY updated_ms DESC, id DESC LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![start, state, limit], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "kind": row.get::<_, String>(1)?,
                    "title": row.get::<_, String>(2)?,
                    "detail": row.get::<_, Option<String>>(3)?,
                    "state": row.get::<_, String>(4)?,
                    "source": row.get::<_, String>(5)?,
                    "evidence": row
                        .get::<_, Option<String>>(6)?
                        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
                    "runId": row.get::<_, Option<String>>(7)?,
                    "createdMs": row.get::<_, i64>(8)?,
                    "updatedMs": row.get::<_, i64>(9)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if rows.len() as i64 == limit {
            rows.last()
                .and_then(|row| row["updatedMs"].as_i64())
                .map(|value| value.to_string())
        } else {
            None
        };
        Ok(json!({ "items": rows, "nextCursor": next_cursor }))
    }

    /// Add a backlog item.
    #[allow(clippy::too_many_arguments)]
    pub fn backlog_add(
        &self,
        id: Option<&str>,
        kind: &str,
        title: &str,
        detail: Option<&str>,
        source: &str,
        run_id: Option<&str>,
        linked_memory_id: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<Value> {
        let title = title.trim();
        if title.is_empty() {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                "backlog items need a title",
            ));
        }
        let id = id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some(memory_id) = linked_memory_id {
            let known: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM memories WHERE id = ?1)",
                params![memory_id],
                |row| row.get(0),
            )?;
            if !known {
                return Err(CoreError::not_found(
                    "MEMORY_NOT_FOUND",
                    "no memory exists with that id",
                ));
            }
        }
        transaction.execute(
            "INSERT INTO improvement_backlog (id, kind, title, detail, state, source, evidence_json, run_id, linked_memory_id, created_ms, updated_ms) \
             VALUES (?1, ?2, ?3, ?4, 'proposed', ?5, NULL, ?6, ?7, ?8, ?8) \
             ON CONFLICT (id) DO UPDATE SET title = excluded.title, detail = excluded.detail, \
              kind = excluded.kind, updated_ms = excluded.updated_ms, \
              linked_memory_id = COALESCE(excluded.linked_memory_id, improvement_backlog.linked_memory_id)",
            params![id, kind, title, detail, source, run_id, linked_memory_id, now_ms],
        )?;
        ledger_insert(
            &transaction,
            "note",
            Some(&id),
            Some("backlog item added"),
            Some(source),
            None,
            now_ms,
        )?;
        transaction.commit()?;
        Ok(json!({ "id": id, "state": "proposed", "linkedMemoryId": linked_memory_id }))
    }

    /// Link or unlink one backlog item to a memory. `None` clears the link.
    pub fn backlog_link(
        &self,
        id: &str,
        memory_id: Option<&str>,
        actor: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<Value> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some(memory_id) = memory_id {
            let known: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM memories WHERE id = ?1)",
                params![memory_id],
                |row| row.get(0),
            )?;
            if !known {
                return Err(CoreError::not_found(
                    "MEMORY_NOT_FOUND",
                    "no memory exists with that id",
                ));
            }
        }
        let changed = transaction.execute(
            "UPDATE improvement_backlog SET linked_memory_id = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, memory_id, now_ms],
        )?;
        if changed == 0 {
            return Err(CoreError::not_found(
                "BACKLOG_ITEM_NOT_FOUND",
                "no backlog item exists with that id",
            ));
        }
        let detail = match memory_id {
            Some(memory_id) => format!("linked to memory {memory_id}"),
            None => "link cleared".to_string(),
        };
        ledger_insert(
            &transaction,
            "note",
            Some(id),
            Some(&detail),
            actor,
            None,
            now_ms,
        )?;
        transaction.commit()?;
        Ok(json!({
            "id": id,
            "linkedMemoryId": memory_id,
            "state": if memory_id.is_some() { "linked" } else { "unlinked" },
        }))
    }

    /// Move a backlog item through the review gate.
    pub fn backlog_update(
        &self,
        id: &str,
        state: &str,
        actor: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<Value> {
        if !BACKLOG_STATES.contains(&state) {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                format!("unknown backlog state: {state}"),
            ));
        }
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE improvement_backlog SET state = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, state, now_ms],
        )?;
        if changed == 0 {
            return Err(CoreError::not_found(
                "BACKLOG_NOT_FOUND",
                "unknown backlog item",
            ));
        }
        ledger_insert(
            &transaction,
            "note",
            Some(id),
            Some(&format!("backlog item marked {state}")),
            actor,
            None,
            now_ms,
        )?;
        transaction.commit()?;
        Ok(json!({ "id": id, "state": state }))
    }

    /// Review gate: what waits on a human decision, plus recent ledger turns.
    pub fn review_gate(&self, now_ms: i64) -> CoreResult<Value> {
        let connection = self.reader().lock().expect("reader lock");
        let counts: Vec<(String, i64)> = {
            let mut statement = connection
                .prepare("SELECT state, COUNT(*) FROM improvement_backlog GROUP BY state")?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut by_state: BTreeMap<String, i64> = BACKLOG_STATES
            .iter()
            .map(|state| (state.to_string(), 0))
            .collect();
        for (state, count) in counts {
            by_state.insert(state, count);
        }
        let pending: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT id, kind, title, state, updated_ms FROM improvement_backlog \
                 WHERE state IN ('proposed', 'accepted') ORDER BY updated_ms DESC LIMIT 50",
            )?;
            statement
                .query_map([], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "kind": row.get::<_, String>(1)?,
                        "title": row.get::<_, String>(2)?,
                        "state": row.get::<_, String>(3)?,
                        "updatedMs": row.get::<_, i64>(4)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let recent_ledger: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT id, entry_type, subject, detail, actor, created_ms FROM evolution_ledger \
                 ORDER BY id DESC LIMIT 10",
            )?;
            statement
                .query_map([], |row| {
                    Ok(json!({
                        "id": row.get::<_, i64>(0)?,
                        "entryType": row.get::<_, String>(1)?,
                        "subject": row.get::<_, Option<String>>(2)?,
                        "detail": row.get::<_, Option<String>>(3)?,
                        "actor": row.get::<_, Option<String>>(4)?,
                        "createdMs": row.get::<_, i64>(5)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let open = by_state.get("proposed").copied().unwrap_or(0);
        Ok(json!({
            "gate": if open == 0 { "clear" } else { "open" },
            "counts": by_state,
            "pending": pending,
            "recentLedger": recent_ledger,
            "observedMs": now_ms,
        }))
    }

    // -----------------------------------------------------------------
    // Evolution ledger
    // -----------------------------------------------------------------

    /// Page the evolution ledger, newest first.
    pub fn ledger_page(
        &self,
        cursor: Option<i64>,
        limit: u32,
        entry_type: Option<&str>,
    ) -> CoreResult<Value> {
        if let Some(entry_type) = entry_type
            && !LEDGER_TYPES.contains(&entry_type)
        {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                format!("unknown ledger entry type: {entry_type}"),
            ));
        }
        let start = cursor.unwrap_or(i64::MAX);
        let limit = page_bounds(limit);
        let connection = self.reader().lock().expect("reader lock");
        let mut statement = connection.prepare(
            "SELECT id, entry_type, subject, detail, actor, memory_revision, created_ms FROM evolution_ledger \
             WHERE id < ?1 AND (?2 IS NULL OR entry_type = ?2) ORDER BY id DESC LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![start, entry_type, limit], |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "entryType": row.get::<_, String>(1)?,
                    "subject": row.get::<_, Option<String>>(2)?,
                    "detail": row.get::<_, Option<String>>(3)?,
                    "actor": row.get::<_, Option<String>>(4)?,
                    "memoryRevision": row.get::<_, Option<i64>>(5)?,
                    "createdMs": row.get::<_, i64>(6)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if rows.len() as i64 == limit {
            rows.last().and_then(|row| row["id"].as_i64())
        } else {
            None
        };
        Ok(json!({ "entries": rows, "nextCursor": next_cursor }))
    }

    /// Append a manual ledger entry.
    pub fn ledger_append(
        &self,
        entry_type: &str,
        subject: Option<&str>,
        detail: &str,
        actor: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<Value> {
        if !LEDGER_TYPES.contains(&entry_type) {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                format!("unknown ledger entry type: {entry_type}"),
            ));
        }
        if detail.trim().is_empty() {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                "ledger entries need a detail",
            ));
        }
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let memory_revision = revision(&transaction)?;
        ledger_insert(
            &transaction,
            entry_type,
            subject,
            Some(detail),
            actor,
            Some(memory_revision),
            now_ms,
        )?;
        let id: i64 = transaction.query_row("SELECT last_insert_rowid()", [], |row| row.get(0))?;
        transaction.commit()?;
        Ok(json!({ "id": id }))
    }

    // -----------------------------------------------------------------
    // Intent journal
    // -----------------------------------------------------------------

    /// List journal entries, optionally filtered by state.
    pub fn journal_list(
        &self,
        cursor: Option<&str>,
        limit: u32,
        state: Option<&str>,
    ) -> CoreResult<Value> {
        if let Some(state) = state
            && !JOURNAL_STATES.contains(&state)
        {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                format!("unknown journal state: {state}"),
            ));
        }
        let start = cursor.unwrap_or(i64::MAX.to_string().as_str()).to_string();
        let start: i64 = start.parse().map_err(|_| {
            CoreError::invalid("ADMIN_ARGUMENT_INVALID", "cursor must be a decimal id")
        })?;
        let limit = page_bounds(limit);
        let connection = self.reader().lock().expect("reader lock");
        let mut statement = connection.prepare(
            "SELECT id, intent, state, note, created_ms, updated_ms FROM intent_journal \
             WHERE updated_ms < ?1 AND (?2 IS NULL OR state = ?2) ORDER BY updated_ms DESC, id DESC LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![start, state, limit], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "intent": row.get::<_, String>(1)?,
                    "state": row.get::<_, String>(2)?,
                    "note": row.get::<_, Option<String>>(3)?,
                    "createdMs": row.get::<_, i64>(4)?,
                    "updatedMs": row.get::<_, i64>(5)?,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if rows.len() as i64 == limit {
            rows.last()
                .and_then(|row| row["updatedMs"].as_i64())
                .map(|value| value.to_string())
        } else {
            None
        };
        Ok(json!({ "items": rows, "nextCursor": next_cursor }))
    }

    /// Record an intent, or update one by id.
    pub fn journal_write(
        &self,
        id: Option<&str>,
        intent: Option<&str>,
        state: &str,
        note: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<Value> {
        if !JOURNAL_STATES.contains(&state) {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                format!("unknown journal state: {state}"),
            ));
        }
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let value = match id {
            Some(id) => {
                let changed = transaction.execute(
                    "UPDATE intent_journal SET state = ?2, note = COALESCE(?3, note), updated_ms = ?4 \
                     WHERE id = ?1",
                    params![id, state, note, now_ms],
                )?;
                if changed == 0 {
                    return Err(CoreError::not_found(
                        "JOURNAL_NOT_FOUND",
                        "unknown journal entry",
                    ));
                }
                json!({ "id": id, "state": state })
            }
            None => {
                let intent = intent
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        CoreError::invalid("ADMIN_ARGUMENT_INVALID", "journal entries need text")
                    })?;
                let id = uuid::Uuid::new_v4().to_string();
                transaction.execute(
                    "INSERT INTO intent_journal (id, intent, state, note, created_ms, updated_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![id, intent, state, note, now_ms],
                )?;
                json!({ "id": id, "state": state })
            }
        };
        transaction.commit()?;
        Ok(value)
    }

    // -----------------------------------------------------------------
    // Repair
    // -----------------------------------------------------------------

    /// Preview repair findings: FTS gaps, missing or stale embedding intents
    /// and stale vectors. Read-only.
    /// Preview repair findings with typed, addressable candidates.
    ///
    /// Candidate ids are `type:memoryId` so a caller can repair exactly the
    /// findings it selected, and the fingerprint binds the selection.
    pub fn repair_preview(&self, source_limit_bytes: u64) -> CoreResult<Value> {
        let connection = self.reader().lock().expect("reader lock");
        let mut candidates: Vec<Value> = Vec::new();
        let mut counts = BTreeMap::new();

        let fts_missing: Vec<String> = {
            let mut statement = connection.prepare(
                "SELECT m.id FROM memories m WHERE m.forgotten = 0 AND m.superseded_by IS NULL \
                 AND NOT EXISTS (SELECT 1 FROM memory_fts WHERE memory_fts.memory_id = m.id) \
                 ORDER BY m.id ASC LIMIT 200",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for id in &fts_missing {
            candidates.push(json!({
                "id": format!("fts_gap:{id}"),
                "type": "fts_gap",
                "memoryId": id,
                "detail": "FTS row missing for an active memory",
            }));
        }
        counts.insert("fts_missing".to_string(), fts_missing.len() as i64);

        let intents_missing: Vec<String> = {
            let mut statement = connection.prepare(
                "SELECT m.id FROM memories m WHERE m.forgotten = 0 AND m.superseded_by IS NULL \
                 AND NOT EXISTS (SELECT 1 FROM embedding_intents WHERE embedding_intents.memory_id = m.id) \
                 ORDER BY m.id ASC LIMIT 200",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for id in &intents_missing {
            candidates.push(json!({
                "id": format!("intent_missing:{id}"),
                "type": "intent_missing",
                "memoryId": id,
                "detail": "embedding intent missing for an active memory",
            }));
        }
        counts.insert("intents_missing".to_string(), intents_missing.len() as i64);

        let intents_stale: Vec<String> = {
            let mut statement = connection.prepare(
                "SELECT m.id FROM memories m JOIN embedding_intents i ON i.memory_id = m.id \
                 WHERE m.forgotten = 0 AND m.superseded_by IS NULL AND i.desired_revision != m.revision \
                 ORDER BY m.id ASC LIMIT 200",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for id in &intents_stale {
            candidates.push(json!({
                "id": format!("intent_stale:{id}"),
                "type": "intent_stale",
                "memoryId": id,
                "detail": "embedding intent trails the memory revision",
            }));
        }
        counts.insert("intents_stale".to_string(), intents_stale.len() as i64);

        let vectors_stale: Vec<String> = {
            let mut statement = connection.prepare(
                "SELECT m.id FROM memories m JOIN memory_vectors v ON v.memory_id = m.id \
                 WHERE m.forgotten = 0 AND m.superseded_by IS NULL AND v.revision != m.revision \
                 ORDER BY m.id ASC LIMIT 200",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for id in &vectors_stale {
            candidates.push(json!({
                "id": format!("vector_stale:{id}"),
                "type": "vector_stale",
                "memoryId": id,
                "detail": "stored vector trails the memory revision",
            }));
        }
        counts.insert("vectors_stale".to_string(), vectors_stale.len() as i64);

        // Complete-source evidence: source generations whose records were
        // captured but never extracted, bounded by the source limit.
        let source_candidates: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT g.source_id, g.generation, s.repository, s.native_session_id                  FROM source_generations g JOIN sources s ON s.source_id = g.source_id \
                 WHERE g.retired_ms IS NULL AND g.disposition = 'active' \
                 AND EXISTS (SELECT 1 FROM source_records r \
                    WHERE r.source_id = g.source_id AND r.generation = g.generation) \
                 AND NOT EXISTS (SELECT 1 FROM extraction_intents i \
                    WHERE i.source_id = g.source_id AND i.generation = g.generation \
                    AND i.state IN ('complete', 'pending', 'running', 'retry_wait')) \
                 ORDER BY g.started_ms ASC LIMIT 100",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(json!({
                    "sourceId": row.get::<_, String>(0)?,
                    "generation": row.get::<_, String>(1)?,
                    "repository": row.get::<_, Option<String>>(2)?,
                    "sessionId": row.get::<_, Option<String>>(3)?,
                }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        counts.insert(
            "source_unextracted".to_string(),
            source_candidates.len() as i64,
        );
        let repairable = fts_missing.len()
            + intents_missing.len()
            + intents_stale.len()
            + vectors_stale.len()
            + source_candidates.len();
        let total_source_bytes: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(observed_size), 0) FROM sources",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let source_limit_exceeded = total_source_bytes as u64 > source_limit_bytes;
        if source_limit_exceeded {
            counts.insert(
                "source_limit_exceeded".to_string(),
                (total_source_bytes as u64 - source_limit_bytes) as i64,
            );
        }
        let mut parts = vec!["repair".to_string()];
        let mut sorted_ids: Vec<String> = candidates
            .iter()
            .filter_map(|candidate| candidate["id"].as_str().map(str::to_string))
            .collect();
        sorted_ids.sort();
        parts.push(sorted_ids.join(","));
        parts.push(source_limit_bytes.to_string());
        Ok(json!({
            "counts": counts,
            "candidates": candidates,
            "sourceCandidates": source_candidates,
            "sourceLimitBytes": source_limit_bytes,
            "sourceLimitExceeded": source_limit_exceeded,
            "totalSourceBytes": total_source_bytes,
            "repairable": repairable,
            "candidateLimitReached": counts.values().any(|value| *value >= 200),
            "fingerprint": crate::store::ops::fingerprint("lore_repair", "", &[parts.join("|")]),
        }))
    }

    /// Apply the previewed repair: rebuild FTS rows, queue missing/stale
    /// intents and drop stale vectors. Snapshot first.
    /// Apply the previewed repair, optionally restricted to
    /// `selectedCandidateIds`. Complete-source repairs are refused when the
    /// observed source bytes exceed the caller's limit, and every finding
    /// that could not be repaired is reported rather than dropped.
    pub fn repair_apply(
        &self,
        plan_fingerprint: &str,
        selected_candidate_ids: &[String],
        source_limit_bytes: u64,
        actor: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<Value> {
        let preview = self.repair_preview(source_limit_bytes)?;
        if preview["fingerprint"].as_str() != Some(plan_fingerprint) {
            return Err(CoreError::precondition(
                "PREVIEW_STALE",
                "the repair preview no longer matches store state; preview again",
            ));
        }
        if preview["sourceLimitExceeded"] == true {
            return Err(CoreError::invalid(
                "SOURCE_LIMIT_EXCEEDED",
                format!(
                    "observed source bytes ({}) exceed the {} byte limit",
                    preview["totalSourceBytes"], source_limit_bytes
                ),
            ));
        }
        let all_candidates: Vec<Value> = preview["candidates"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let selected: Vec<&Value> = if selected_candidate_ids.is_empty() {
            all_candidates.iter().collect()
        } else {
            let wanted: std::collections::HashSet<&str> =
                selected_candidate_ids.iter().map(String::as_str).collect();
            all_candidates
                .iter()
                .filter(|candidate| {
                    candidate["id"]
                        .as_str()
                        .is_some_and(|id| wanted.contains(id))
                })
                .collect()
        };
        let unknown: Vec<String> = selected_candidate_ids
            .iter()
            .filter(|id| {
                !all_candidates
                    .iter()
                    .any(|candidate| candidate["id"] == **id)
            })
            .cloned()
            .collect();
        if !unknown.is_empty() {
            return Err(CoreError::invalid(
                "CANDIDATE_NOT_FOUND",
                format!("unknown repair candidates: {}", unknown.join(", ")),
            ));
        }
        let snapshot = self.snapshot_now(now_ms)?;
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut revision = revision(&transaction)?;
        let run_id = uuid::Uuid::new_v4().to_string();
        Store::insert_run(
            &transaction,
            &run_id,
            "lore_repair",
            plan_fingerprint,
            actor,
            now_ms,
        )?;

        let mut fts_rows = 0i64;
        let mut stale_intents = 0i64;
        let mut vectors_removed = 0i64;
        let mut unresolved: Vec<Value> = Vec::new();
        for candidate in &selected {
            let kind = candidate["type"].as_str().unwrap_or_default();
            let Some(memory_id) = candidate["memoryId"].as_str().map(str::to_string) else {
                unresolved.push(json!({ "id": candidate["id"], "reason": "MALFORMED_CANDIDATE" }));
                continue;
            };
            match kind {
                "fts_gap" => {
                    let exists: bool = transaction
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM memory_fts WHERE memory_id = ?1)",
                            params![memory_id],
                            |row| row.get(0),
                        )
                        .unwrap_or(false);
                    if exists {
                        unresolved
                            .push(json!({ "id": candidate["id"], "reason": "ALREADY_REPAIRED" }));
                        continue;
                    }
                    let (content, kind): (String, String) = transaction
                        .query_row(
                            "SELECT content, kind FROM memories WHERE id = ?1",
                            params![memory_id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .map_err(|_| CoreError::not_found("MEMORY_NOT_FOUND", "memory vanished"))?;
                    transaction.execute(
                        "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, ?2, '', ?3)",
                        params![content, kind, memory_id],
                    )?;
                    Store::add_run_item(
                        &transaction,
                        &run_id,
                        fts_rows,
                        &memory_id,
                        "repaired",
                        Some("fts_gap"),
                        now_ms,
                    )?;
                    fts_rows += 1;
                }
                "intent_missing" | "intent_stale" => {
                    let (content_hash, memory_revision): (String, i64) = transaction
                        .query_row(
                            "SELECT content_hash, revision FROM memories WHERE id = ?1",
                            params![memory_id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .map_err(|_| CoreError::not_found("MEMORY_NOT_FOUND", "memory vanished"))?;
                    let state = if self.embedding_enabled {
                        "pending"
                    } else {
                        "disabled"
                    };
                    transaction.execute(
                        "INSERT INTO embedding_intents (memory_id, desired_revision, state, attempts, next_attempt_ms, terminal_reason, content_hash, model_identity, updated_ms) \
                         VALUES (?1, ?2, ?3, 0, NULL, NULL, ?4, ?5, ?6) \
                         ON CONFLICT (memory_id) DO UPDATE SET desired_revision = excluded.desired_revision, \
                          state = excluded.state, attempts = 0, next_attempt_ms = NULL, terminal_reason = NULL, \
                          content_hash = excluded.content_hash, model_identity = excluded.model_identity, updated_ms = excluded.updated_ms",
                        params![
                            memory_id,
                            memory_revision,
                            state,
                            content_hash,
                            self.embedding_identity.as_deref().unwrap_or(""),
                            now_ms
                        ],
                    )?;
                    Store::add_run_item(
                        &transaction,
                        &run_id,
                        stale_intents,
                        &memory_id,
                        "repaired",
                        Some(kind),
                        now_ms,
                    )?;
                    stale_intents += 1;
                }
                "vector_stale" => {
                    let removed = transaction.execute(
                        "DELETE FROM memory_vectors WHERE memory_id = ?1 AND revision != \
                         (SELECT revision FROM memories WHERE id = ?1)",
                        params![memory_id],
                    )?;
                    if removed == 0 {
                        unresolved
                            .push(json!({ "id": candidate["id"], "reason": "ALREADY_REPAIRED" }));
                        continue;
                    }
                    vectors_removed += removed as i64;
                    Store::add_run_item(
                        &transaction,
                        &run_id,
                        vectors_removed - 1,
                        &memory_id,
                        "repaired",
                        Some("vector_stale"),
                        now_ms,
                    )?;
                }
                other => unresolved.push(json!({
                    "id": candidate["id"],
                    "reason": "UNSUPPORTED_TYPE",
                    "type": other,
                })),
            }
        }

        if fts_rows > 0 || stale_intents > 0 || vectors_removed > 0 {
            revision += 1;
            transaction.execute(
                "UPDATE store_metadata SET memory_revision = ?1, derived_generation = derived_generation + 1 WHERE id = 1",
                params![revision],
            )?;
        }
        ledger_insert(
            &transaction,
            "repair",
            None,
            Some(&format!(
                "selected={} fts={fts_rows} intents={stale_intents} vectors={vectors_removed} unresolved={}",
                selected.len(),
                unresolved.len()
            )),
            actor,
            Some(revision),
            now_ms,
        )?;
        let mut counts = BTreeMap::new();
        counts.insert("ftsRebuilt".to_string(), fts_rows);
        counts.insert("intentsQueued".to_string(), stale_intents);
        counts.insert("vectorsRemoved".to_string(), vectors_removed);
        counts.insert("unresolved".to_string(), unresolved.len() as i64);
        counts.insert("selected".to_string(), selected.len() as i64);
        Store::finish_run_in(
            &transaction,
            &run_id,
            if unresolved.is_empty() {
                "complete"
            } else {
                "complete_with_gaps"
            },
            &counts,
            None,
            now_ms,
        )?;
        transaction.commit()?;
        Ok(json!({
            "runId": run_id,
            "snapshot": snapshot.display().to_string(),
            "counts": counts,
            "unresolved": unresolved,
            "state": if unresolved.is_empty() { "complete" } else { "complete_with_gaps" },
            "committedRevision": revision,
        }))
    }

    // -----------------------------------------------------------------
    // Replay
    // -----------------------------------------------------------------

    /// Replay the frozen extraction corpus and report per-case outcomes.
    /// Deterministic and provider-free; never writes memories.
    pub fn replay_run(&self, limit: u32, family: Option<&str>) -> CoreResult<Value> {
        #[derive(Deserialize)]
        struct Fixture {
            version: u32,
            blueprints: Vec<Blueprint>,
        }
        #[derive(Deserialize)]
        struct Blueprint {
            id: String,
            #[serde(default)]
            family: Option<String>,
            repository: Option<String>,
            turns: Vec<FixtureTurn>,
            expected: Vec<Expected>,
            #[serde(default)]
            forbidden: Vec<Expected>,
        }
        #[derive(Deserialize)]
        struct FixtureTurn {
            role: String,
            text: String,
        }
        #[derive(Deserialize)]
        struct Expected {
            #[serde(rename = "type", default)]
            kind: Option<String>,
            #[serde(default)]
            #[allow(dead_code)]
            scope: Option<String>,
            #[serde(default)]
            anchors: Vec<String>,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../tests/v2/fixtures/extraction-corpus.json"
        )))
        .map_err(|error| CoreError::internal("REPLAY_FIXTURE_INVALID", error.to_string()))?;
        let limit = limit.clamp(1, 200) as usize;
        let mut passed = 0usize;
        let mut failed = 0usize;
        let mut failures: Vec<Value> = Vec::new();
        for blueprint in fixture
            .blueprints
            .iter()
            .filter(|blueprint| {
                family.is_none_or(|value| blueprint.family.as_deref() == Some(value))
            })
            .take(limit)
        {
            let turns: Vec<TurnInput> = blueprint
                .turns
                .iter()
                .enumerate()
                .map(|(index, turn)| TurnInput {
                    role: turn.role.clone(),
                    text: turn.text.clone(),
                    evidence_key: format!("{}:{index}", blueprint.id),
                    turn_index: index as i64,
                    completeness: String::new(),
                })
                .collect();
            let result = extract(blueprint.repository.as_deref(), &turns);
            // Propositions retired by a later correction are not active.
            let retired: HashSet<&str> = result
                .proposals
                .iter()
                .flat_map(|proposal| proposal.retires.iter().map(String::as_str))
                .collect();
            let active: Vec<&crate::extraction::Proposal> = result
                .proposals
                .iter()
                .filter(|proposal| !retired.contains(proposal.topic_key.as_str()))
                .collect();
            let mut ok = true;
            let mut missing = Vec::new();
            for expected in &blueprint.expected {
                let matched = active.iter().any(|proposal| {
                    replay_matches(proposal, expected.kind.as_deref(), &expected.anchors)
                });
                if !matched {
                    ok = false;
                    missing.push(
                        expected
                            .anchors
                            .first()
                            .cloned()
                            .unwrap_or_else(|| "expected".to_string()),
                    );
                }
            }
            let mut forbidden_hits = Vec::new();
            for forbidden in &blueprint.forbidden {
                if active
                    .iter()
                    .any(|proposal| replay_anchor_matches(&proposal.content, &forbidden.anchors))
                {
                    ok = false;
                    forbidden_hits.push(
                        forbidden
                            .anchors
                            .first()
                            .cloned()
                            .unwrap_or_else(|| "forbidden".to_string()),
                    );
                }
            }
            if ok {
                passed += 1;
            } else {
                failed += 1;
                if failures.len() < 20 {
                    failures.push(json!({
                        "id": blueprint.id,
                        "family": blueprint.family.clone().unwrap_or_default(),
                        "missing": missing,
                        "forbiddenHits": forbidden_hits,
                        "proposals": result.proposals.len(),
                    }));
                }
            }
        }
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let memory_revision = revision(&transaction)?;
        ledger_insert(
            &transaction,
            "replay",
            None,
            Some(&format!("passed={passed} failed={failed}")),
            None,
            Some(memory_revision),
            crate::store::ops::now_ms(),
        )?;
        transaction.commit()?;
        Ok(json!({
            "corpusVersion": fixture.version,
            "total": passed + failed,
            "passed": passed,
            "failed": failed,
            "failures": failures,
        }))
    }
}

fn is_numeric(token: &str) -> bool {
    (token.chars().all(|character| character.is_ascii_digit()) && !token.is_empty())
        || matches!(
            token,
            "zero"
                | "one"
                | "two"
                | "three"
                | "four"
                | "five"
                | "six"
                | "seven"
                | "eight"
                | "nine"
                | "ten"
                | "eleven"
                | "twelve"
                | "thirteen"
                | "fourteen"
                | "fifteen"
                | "sixteen"
                | "seventeen"
                | "eighteen"
                | "nineteen"
                | "twenty"
                | "thirty"
                | "forty"
                | "fifty"
                | "sixty"
                | "seventy"
                | "eighty"
                | "ninety"
                | "hundred"
                | "thousand"
                | "million"
        )
}

fn content_tokens(content: &str) -> HashSet<String> {
    content
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .collect()
}

fn replay_anchor_matches(content: &str, anchors: &[String]) -> bool {
    if anchors.is_empty() {
        return false;
    }
    let tokens = content_tokens(content);
    let anchor_tokens: Vec<String> = anchors
        .iter()
        .flat_map(|anchor| {
            anchor
                .to_lowercase()
                .split(|character: char| !character.is_alphanumeric())
                .filter(|token| !token.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect();
    if anchor_tokens.is_empty() {
        return false;
    }
    if anchor_tokens
        .iter()
        .any(|token| (token.len() <= 2 || is_numeric(token)) && !tokens.contains(token))
    {
        return false;
    }
    let matched = anchor_tokens
        .iter()
        .filter(|token| {
            tokens.contains(*token)
                || tokens
                    .iter()
                    .any(|other| other.starts_with(token.as_str()) || token.starts_with(other))
        })
        .count();
    (matched as f64) / (anchor_tokens.len() as f64) >= 0.72
}

fn replay_kind_compatible(actual: &str, expected: &str) -> bool {
    actual == expected
        || (matches!(actual, "directive" | "user_preference")
            && matches!(expected, "directive" | "user_preference"))
}

fn replay_matches(
    proposal: &crate::extraction::Proposal,
    expected_kind: Option<&str>,
    anchors: &[String],
) -> bool {
    expected_kind.is_none_or(|kind| replay_kind_compatible(&proposal.kind, kind))
        && replay_anchor_matches(&proposal.content, anchors)
}
