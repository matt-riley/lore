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
        transaction.execute(
            "INSERT INTO improvement_backlog (id, kind, title, detail, state, source, evidence_json, run_id, created_ms, updated_ms) \
             VALUES (?1, ?2, ?3, ?4, 'proposed', ?5, NULL, ?6, ?7, ?7) \
             ON CONFLICT (id) DO UPDATE SET title = excluded.title, detail = excluded.detail, \
              kind = excluded.kind, updated_ms = excluded.updated_ms",
            params![id, kind, title, detail, source, run_id, now_ms],
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
        Ok(json!({ "id": id, "state": "proposed" }))
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
    pub fn repair_preview(&self) -> CoreResult<Value> {
        let connection = self.reader().lock().expect("reader lock");
        let fts_missing: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memories m WHERE m.forgotten = 0 AND m.superseded_by IS NULL \
             AND NOT EXISTS (SELECT 1 FROM memory_fts WHERE memory_fts.memory_id = m.id)",
            [],
            |row| row.get(0),
        )?;
        let intents_missing: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memories m WHERE m.forgotten = 0 AND m.superseded_by IS NULL \
             AND NOT EXISTS (SELECT 1 FROM embedding_intents WHERE embedding_intents.memory_id = m.id)",
            [],
            |row| row.get(0),
        )?;
        let intents_stale: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memories m JOIN embedding_intents i ON i.memory_id = m.id \
             WHERE m.forgotten = 0 AND m.superseded_by IS NULL AND i.desired_revision != m.revision",
            [],
            |row| row.get(0),
        )?;
        let vectors_stale: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memories m JOIN memory_vectors v ON v.memory_id = m.id \
             WHERE m.forgotten = 0 AND m.superseded_by IS NULL AND v.revision != m.revision",
            [],
            |row| row.get(0),
        )?;
        let findings = [
            ("fts_missing", fts_missing),
            ("intents_missing", intents_missing),
            ("intents_stale", intents_stale),
            ("vectors_stale", vectors_stale),
        ];
        let mut parts = vec!["repair".to_string()];
        let mut counts = BTreeMap::new();
        for (name, count) in findings {
            parts.push(format!("{name}={count}"));
            counts.insert(name.to_string(), count);
        }
        Ok(json!({
            "counts": counts,
            "repairable": fts_missing + intents_missing + intents_stale + vectors_stale,
            "fingerprint": crate::store::ops::fingerprint("lore_repair", "", &[parts.join("|")]),
        }))
    }

    /// Apply the previewed repair: rebuild FTS rows, queue missing/stale
    /// intents and drop stale vectors. Snapshot first.
    pub fn repair_apply(
        &self,
        plan_fingerprint: &str,
        actor: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<Value> {
        let preview = self.repair_preview()?;
        if preview["fingerprint"].as_str() != Some(plan_fingerprint) {
            return Err(CoreError::precondition(
                "PREVIEW_STALE",
                "the repair preview no longer matches store state; preview again",
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

        let fts_rows: Vec<(String, String, String, String)> = {
            let mut statement = transaction.prepare(
                "SELECT m.id, m.content, m.kind, COALESCE(m.tags_json, '[]') FROM memories m \
                 WHERE m.forgotten = 0 AND m.superseded_by IS NULL \
                 AND NOT EXISTS (SELECT 1 FROM memory_fts WHERE memory_fts.memory_id = m.id)",
            )?;
            statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (memory_id, content, kind, _tags_json) in &fts_rows {
            transaction.execute(
                "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, ?2, '', ?3)",
                params![content, kind, memory_id],
            )?;
        }

        let stale_intents: Vec<String> = {
            let mut statement = transaction.prepare(
                "SELECT m.id FROM memories m LEFT JOIN embedding_intents i ON i.memory_id = m.id \
                 WHERE m.forgotten = 0 AND m.superseded_by IS NULL \
                 AND (i.memory_id IS NULL OR i.desired_revision != m.revision)",
            )?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for memory_id in &stale_intents {
            let (content_hash, memory_revision): (String, i64) = transaction.query_row(
                "SELECT content_hash, revision FROM memories WHERE id = ?1",
                params![memory_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
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
        }

        let vectors_removed = transaction.execute(
            "DELETE FROM memory_vectors WHERE EXISTS ( \
             SELECT 1 FROM memories m WHERE m.id = memory_vectors.memory_id \
             AND (m.forgotten = 1 OR m.superseded_by IS NOT NULL OR m.revision != memory_vectors.revision))",
            [],
        )? as i64;

        if fts_rows.is_empty() && stale_intents.is_empty() && vectors_removed == 0 {
            // Nothing to do: keep revision unchanged but still record the run.
        } else {
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
                "fts={} intents={} vectors={}",
                fts_rows.len(),
                stale_intents.len(),
                vectors_removed
            )),
            actor,
            Some(revision),
            now_ms,
        )?;
        let mut counts = BTreeMap::new();
        counts.insert("ftsRebuilt".to_string(), fts_rows.len() as i64);
        counts.insert("intentsQueued".to_string(), stale_intents.len() as i64);
        counts.insert("vectorsRemoved".to_string(), vectors_removed);
        Store::finish_run_in(&transaction, &run_id, "complete", &counts, None, now_ms)?;
        transaction.commit()?;
        Ok(json!({
            "runId": run_id,
            "snapshot": snapshot.display().to_string(),
            "counts": counts,
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
