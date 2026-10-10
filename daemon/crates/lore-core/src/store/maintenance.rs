//! Maintenance task inventory: persisted due times, one active claim per
//! task/scope, durable run history and the dashboard report.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::json;

use crate::error::{CoreError, CoreResult};
use crate::store::Store;

/// Tasks in the ported inventory, with (default enabled, default cadence
/// seconds). A zero cadence is a bounded 60-second opportunity only while
/// the task is enabled.
pub const MAINTENANCE_TASK_NAMES: [&str; 9] = [
    "memoryHygiene",
    "deferredExtraction",
    "validationCorpus",
    "replayCorpus",
    "backlogReview",
    "traceCompaction",
    "indexUpkeep",
    "doctorSnapshot",
    "extractionRevalidation",
];

/// Zero cadence floor, in seconds, while a task is enabled.
pub const ZERO_CADENCE_FLOOR_S: i64 = 60;

/// Scope used when a task is not repository-scoped.
pub const DEFAULT_MAINTENANCE_SCOPE: &str = "global";

/// Cadence seconds used when a task is enabled with no configured cadence.
pub const DEFAULT_CADENCE_S: i64 = 900;

/// One row of persisted task state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceTaskRow {
    pub task: String,
    pub scope: String,
    pub enabled: bool,
    pub cadence_seconds: i64,
    pub due_ms: i64,
    pub last_run_ms: Option<i64>,
    pub last_state: Option<String>,
    pub last_error: Option<String>,
    pub runs: i64,
    pub failures: i64,
    pub needs_attention: i64,
}

/// One row of durable maintenance run history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceRunRow {
    pub run_id: String,
    pub task: String,
    pub scope: String,
    pub trigger: Option<String>,
    pub state: Option<String>,
    pub dry_run: Option<bool>,
    pub started_ms: Option<i64>,
    pub finished_ms: Option<i64>,
    pub repository: Option<String>,
    pub completed_count: Option<i64>,
    pub failed_count: Option<i64>,
    pub needs_attention_count: Option<i64>,
}

impl Store {
    /// Ensure state rows exist for the configured tasks and refresh their
    /// enabled/cadence values. Idempotent.
    pub fn maintenance_sync(
        &self,
        config: &crate::config::ResolvedMaintenance,
        scope: &str,
        now_ms: i64,
    ) -> CoreResult<()> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        for task in MAINTENANCE_TASK_NAMES {
            let configured = config.tasks.get(task);
            let default_enabled = matches!(task, "deferredExtraction" | "indexUpkeep");
            let enabled = configured
                .map(|entry| entry.enabled)
                .unwrap_or(default_enabled);
            let cadence = configured.map(|entry| entry.cadence_seconds).unwrap_or(
                if task == "extractionRevalidation" {
                    86_400
                } else {
                    DEFAULT_CADENCE_S
                },
            );
            // A zero cadence stays a bounded opportunity, never a busy loop.
            let effective_cadence = if enabled && cadence <= 0 {
                ZERO_CADENCE_FLOOR_S
            } else {
                cadence.max(0)
            };
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM maintenance_task_state WHERE task = ?1 AND scope = ?2)",
                params![task, scope],
                |row| row.get(0),
            )?;
            if exists {
                transaction.execute(
                    "UPDATE maintenance_task_state SET enabled = ?3, cadence_seconds = ?4 WHERE task = ?1 AND scope = ?2",
                    params![task, scope, enabled as i64, effective_cadence],
                )?;
            } else {
                let initial_cadence = if enabled && cadence <= 0 {
                    ZERO_CADENCE_FLOOR_S
                } else {
                    cadence.max(0)
                };
                transaction.execute(
                    "INSERT INTO maintenance_task_state (task, scope, enabled, cadence_seconds, due_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![task, scope, enabled as i64, initial_cadence, now_ms],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Current state rows for a scope.
    pub fn maintenance_tasks(&self, scope: &str) -> CoreResult<Vec<MaintenanceTaskRow>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut statement = connection.prepare(
            "SELECT task, scope, enabled, cadence_seconds, due_ms, last_run_ms, last_state, \
             last_error, runs, failures, needs_attention FROM maintenance_task_state \
             WHERE scope = ?1 ORDER BY task ASC",
        )?;
        let rows = statement.query_map(params![scope], |row| {
            Ok(MaintenanceTaskRow {
                task: row.get(0)?,
                scope: row.get(1)?,
                enabled: row.get::<_, i64>(2)? != 0,
                cadence_seconds: row.get(3)?,
                due_ms: row.get(4)?,
                last_run_ms: row.get(5)?,
                last_state: row.get(6)?,
                last_error: row.get(7)?,
                runs: row.get(8)?,
                failures: row.get(9)?,
                needs_attention: row.get(10)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Tasks whose due time has passed and that have no active claim.
    pub fn maintenance_due(&self, scope: &str, now_ms: i64) -> CoreResult<Vec<MaintenanceTaskRow>> {
        let tasks = self.maintenance_tasks(scope)?;
        let mut due = Vec::new();
        for task in tasks {
            if !task.enabled || task.due_ms > now_ms {
                continue;
            }
            if self.maintenance_has_active_claim(&task.task, scope)? {
                continue;
            }
            due.push(task);
        }
        Ok(due)
    }

    /// True while a durable run for this task/scope is queued or running.
    pub fn maintenance_has_active_claim(&self, task: &str, scope: &str) -> CoreResult<bool> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let active = connection.query_row(
            "SELECT COUNT(*) FROM maintenance_runs WHERE task = ?1 AND scope = ?2 \
             AND state IN ('queued', 'running')",
            params![task, scope],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(active > 0)
    }

    /// Claim one task by inserting a durable run; `None` when already claimed.
    /// A missed interval is coalesced: the next due time is computed from
    /// now, so a sleeping daemon runs once on wake rather than replaying
    /// every tick it missed.
    pub fn maintenance_claim(
        &self,
        task: &str,
        scope: &str,
        trigger: &str,
        dry_run: bool,
        now_ms: i64,
    ) -> CoreResult<Option<String>> {
        if self.maintenance_has_active_claim(task, scope)? {
            return Ok(None);
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let inserted = transaction.execute(
            "INSERT INTO maintenance_runs (run_id, task, scope, trigger, state, dry_run, started_ms) \
             VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6)",
            params![run_id, task, scope, trigger, dry_run as i64, now_ms],
        )?;
        if inserted == 0 {
            return Ok(None);
        }
        transaction.commit()?;
        Ok(Some(run_id))
    }

    /// Finish a claimed run and advance the task's due time by its cadence.
    /// A missed-while-running interval coalesces to one run from now.
    #[allow(clippy::too_many_arguments)]
    pub fn maintenance_finish(
        &self,
        run_id: &str,
        state: &str,
        completed: i64,
        failed: i64,
        needs_attention: i64,
        detail: Option<Value>,
        now_ms: i64,
    ) -> CoreResult<()> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let (task, scope, started_ms): (String, String, i64) = transaction
            .query_row(
                "SELECT task, scope, started_ms FROM maintenance_runs WHERE run_id = ?1",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| CoreError::not_found("MAINTENANCE_RUN_NOT_FOUND", "unknown run"))?;
        let _ = started_ms;
        let mut counts = serde_json::Map::new();
        counts.insert("completed".to_string(), completed.into());
        counts.insert("failed".to_string(), failed.into());
        counts.insert("needsAttention".to_string(), needs_attention.into());
        let counts_json = serde_json::to_string(&counts)?;
        let detail_json = serde_json::to_string(&detail.unwrap_or(Value::Null))?;
        transaction.execute(
            "UPDATE maintenance_runs SET state = ?1, finished_ms = ?2, completed_count = ?3, \
             failed_count = ?4, needs_attention_count = ?5, counts_json = ?6, detail_json = ?7 \
             WHERE run_id = ?8",
            params![
                state,
                now_ms,
                completed,
                failed,
                needs_attention,
                counts_json,
                detail_json,
                run_id
            ],
        )?;
        let cadence: i64 = transaction
            .query_row(
                "SELECT cadence_seconds FROM maintenance_task_state WHERE task = ?1 AND scope = ?2",
                params![task, scope],
                |row| row.get(0),
            )
            .unwrap_or(DEFAULT_CADENCE_S);
        let stride = if cadence > 0 {
            cadence
        } else {
            ZERO_CADENCE_FLOOR_S
        };
        let error = if state == "failed" {
            Some("see run detail")
        } else {
            None
        };
        transaction.execute(
            "UPDATE maintenance_task_state SET last_run_ms = ?1, last_state = ?2, last_error = ?3, \
             runs = runs + 1, \
             failures = failures + ?4, needs_attention = needs_attention + ?5, \
             due_ms = ?1 + ?6 * 1000 \
             WHERE task = ?7 AND scope = ?8",
            params![
                now_ms,
                state,
                error,
                if state == "failed" { 1 } else { 0 },
                needs_attention,
                stride,
                task,
                scope
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Cancel a queued/running run without touching task counters.
    pub fn maintenance_cancel(&self, run_id: &str, now_ms: i64) -> CoreResult<bool> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE maintenance_runs SET state = 'cancelled', finished_ms = ?1 \
             WHERE run_id = ?2 AND state IN ('queued', 'running')",
            params![now_ms, run_id],
        )?;
        transaction.commit()?;
        Ok(changed > 0)
    }
}

/// Report payload for the dashboard and `lore maintenance --status`.
pub fn maintenance_report(store: &Store, scopes: &[String], limit: u32) -> CoreResult<Value> {
    let limit = limit.clamp(1, 200) as i64;
    let mut task_states: Vec<Value> = Vec::new();
    let mut due_tasks: Vec<Value> = Vec::new();
    for scope in scopes {
        for row in store.maintenance_tasks(scope)? {
            task_states.push(serde_json::to_value(&row)?);
        }
        let now = crate::store::ops::now_ms();
        for row in store.maintenance_due(scope, now)? {
            due_tasks.push(json!({
                "task": row.task,
                "scope": row.scope,
                "dueMs": row.due_ms,
                "lastRunMs": row.last_run_ms,
                "lastState": row.last_state,
            }));
        }
    }
    let connection = store.reader();
    let connection = connection.lock().expect("reader lock");
    let mut statement = connection.prepare(
        "SELECT run_id, task, scope, trigger, state, dry_run, started_ms, finished_ms, \
         completed_count, failed_count, needs_attention_count FROM maintenance_runs \
         WHERE scope IN (SELECT value FROM json_each(?1)) ORDER BY started_ms DESC LIMIT ?2",
    )?;
    let scope_json = serde_json::to_string(scopes)?;
    let rows = statement.query_map(params![scope_json, limit], |row| {
        Ok(json!({
            "runId": row.get::<_, String>(0)?,
            "task": row.get::<_, String>(1)?,
            "scope": row.get::<_, String>(2)?,
            "trigger": row.get::<_, String>(3)?,
            "state": row.get::<_, String>(4)?,
            "dryRun": row.get::<_, i64>(5)? != 0,
            "startedMs": row.get::<_, i64>(6)?,
            "finishedMs": row.get::<_, Option<i64>>(7)?,
            "completedCount": row.get::<_, i64>(8)?,
            "failedCount": row.get::<_, i64>(9)?,
            "needsAttentionCount": row.get::<_, i64>(10)?,
        }))
    })?;
    let runs: Vec<Value> = rows.collect::<Result<_, _>>()?;
    Ok(json!({
        "runs": runs,
        "taskStates": task_states,
        "dueTasks": due_tasks,
        "deferred": [],
    }))
}
impl Store {
    /// Active memories whose expiry has passed: hygiene candidates, reported
    /// in shadow mode and marked only by an explicit manual apply.
    /// Memories that hygiene may retire: expired rows, plus identical copies
    /// (same content hash, same scope and repository) beyond the oldest one.
    /// Duplicates are retired rather than merged so the exact-content rows stay
    /// recoverable through the run marker.
    pub fn hygiene_candidates(&self, now_ms: i64, limit: usize) -> CoreResult<Vec<Value>> {
        let limit = limit.clamp(1, 200) as i64;
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut candidates: Vec<Value> = Vec::new();
        {
            let mut statement = connection.prepare(
                "SELECT id, revision, content_hash, scope, repository FROM memories \
                 WHERE forgotten = 0 AND superseded_by IS NULL AND expires_at_ms IS NOT NULL \
                 AND expires_at_ms <= ?1 ORDER BY expires_at_ms ASC, id ASC LIMIT ?2",
            )?;
            let rows = statement.query_map(params![now_ms, limit], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "revision": row.get::<_, i64>(1)?,
                    "contentHash": row.get::<_, String>(2)?,
                    "scope": row.get::<_, String>(3)?,
                    "repository": row.get::<_, Option<String>>(4)?,
                    "reason": "expired",
                }))
            })?;
            candidates.extend(rows.collect::<Result<Vec<_>, _>>()?);
        }
        {
            // Keep the oldest copy of each identical group (ties broken by id)
            // so the surviving row is stable across runs.
            let mut statement = connection.prepare(
                "SELECT id, revision, content_hash, scope, repository FROM memories m \
                 WHERE forgotten = 0 AND superseded_by IS NULL \
                 AND EXISTS (SELECT 1 FROM memories keeper WHERE keeper.forgotten = 0 \
                   AND keeper.superseded_by IS NULL AND keeper.content_hash = m.content_hash \
                   AND COALESCE(keeper.repository, '') = COALESCE(m.repository, '') \
                   AND keeper.scope = m.scope \
                   AND (keeper.created_ms < m.created_ms \
                        OR (keeper.created_ms = m.created_ms AND keeper.id < m.id))) \
                 ORDER BY m.created_ms ASC, m.id ASC LIMIT ?1",
            )?;
            let rows = statement.query_map(params![limit], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "revision": row.get::<_, i64>(1)?,
                    "contentHash": row.get::<_, String>(2)?,
                    "scope": row.get::<_, String>(3)?,
                    "repository": row.get::<_, Option<String>>(4)?,
                    "reason": "duplicate",
                }))
            })?;
            let duplicates: Vec<Value> = rows.collect::<Result<_, _>>()?;
            let seen: std::collections::HashSet<String> = candidates
                .iter()
                .filter_map(|entry| entry["id"].as_str().map(str::to_string))
                .collect();
            candidates.extend(
                duplicates
                    .into_iter()
                    .filter(|entry| entry["id"].as_str().is_some_and(|id| !seen.contains(id)))
                    .take((limit as usize).saturating_sub(candidates.len())),
            );
        }
        Ok(candidates)
    }

    /// Mark hygiene candidates under one exact marker. Content and FTS rows
    /// are preserved so the marker can be rolled back byte-for-byte.
    pub fn hygiene_apply(
        &self,
        candidates: &[Value],
        marker: &str,
        now_ms: i64,
    ) -> CoreResult<usize> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let mut applied = 0usize;
        for candidate in candidates {
            let Some(id) = candidate["id"].as_str() else {
                continue;
            };
            let content_hash = candidate["contentHash"].as_str().unwrap_or("");
            let scope = candidate["scope"].as_str().unwrap_or("repo");
            let repository = candidate["repository"].as_str();
            revision += 1;
            transaction.execute(
                "UPDATE memories SET forgotten = 1, revision = ?2, updated_ms = ?3 WHERE id = ?1",
                params![id, revision, now_ms],
            )?;
            transaction.execute(
                "INSERT INTO suppressions (memory_id, scope, repository, fingerprint, reason, revision, created_ms, state) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active') \
                 ON CONFLICT (memory_id, scope, COALESCE(repository, ''), fingerprint) DO NOTHING",
                params![id, scope, repository, content_hash, marker, revision, now_ms],
            )?;
            applied += 1;
        }
        if applied > 0 {
            transaction.execute(
                "UPDATE store_metadata SET memory_revision = ?1, active_memories = \
                 (SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL), \
                 forgotten_memories = (SELECT COUNT(*) FROM memories WHERE forgotten = 1) WHERE id = 1",
                params![revision],
            )?;
        }
        transaction.commit()?;
        Ok(applied)
    }

    /// Roll back one hygiene run exactly: un-forget the ids recorded in its
    /// detail and delete only that run's suppression marker.
    pub fn hygiene_rollback(&self, run_id: &str) -> CoreResult<i64> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let detail_json: String = transaction
            .query_row(
                "SELECT detail_json FROM maintenance_runs WHERE run_id = ?1 AND task = 'memoryHygiene'",
                params![run_id],
                |row| row.get(0),
            )
            .map_err(|_| {
                CoreError::not_found("MAINTENANCE_RUN_NOT_FOUND", "unknown hygiene run")
            })?;
        let detail: Value = serde_json::from_str(&detail_json).unwrap_or(Value::Null);
        let marker = detail["marker"]
            .as_str()
            .ok_or_else(|| {
                CoreError::invalid(
                    "MAINTENANCE_NOT_APPLIED",
                    "that run has no applied marker to roll back",
                )
            })?
            .to_string();
        let applied = detail["applied"].as_array().cloned().unwrap_or_default();
        let mut revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let mut restored = 0i64;
        for candidate in &applied {
            let Some(id) = candidate["id"].as_str() else {
                continue;
            };
            let marker_revisions: i64 = transaction.execute(
                "DELETE FROM suppressions WHERE memory_id = ?1 AND reason = ?2",
                params![id, marker],
            )? as i64;
            let _ = marker_revisions;
            revision += 1;
            let changed = transaction.execute(
                "UPDATE memories SET forgotten = 0, revision = ?2, updated_ms = ?3 \
                 WHERE id = ?1 AND forgotten = 1",
                params![id, revision, crate::store::ops::now_ms()],
            )?;
            if changed > 0 {
                restored += 1;
            }
        }
        transaction.execute(
            "UPDATE store_metadata SET memory_revision = ?1, active_memories = \
             (SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL), \
             forgotten_memories = (SELECT COUNT(*) FROM memories WHERE forgotten = 1) WHERE id = 1",
            params![revision],
        )?;
        transaction.commit()?;
        Ok(restored)
    }

    /// Dry-run count of embedding jobs whose lease has expired.
    pub fn embedding_counts_stale(&self, now_ms: i64) -> CoreResult<i64> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        Ok(connection.query_row(
            "SELECT COUNT(*) FROM embedding_jobs WHERE state = 'running' \
             AND lease_expires_ms IS NOT NULL AND lease_expires_ms <= ?1",
            params![now_ms],
            |row| row.get(0),
        )?)
    }

    /// Vectors whose revision trails their memory.
    pub fn stale_vector_count(&self) -> CoreResult<i64> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        Ok(connection.query_row(
            "SELECT COUNT(*) FROM memories m JOIN memory_vectors v ON v.memory_id = m.id \
             WHERE m.forgotten = 0 AND m.superseded_by IS NULL AND v.revision != m.revision",
            [],
            |row| row.get(0),
        )?)
    }

    /// Drop stale vectors (derived data; intents rebuild them).
    pub fn drop_stale_vectors(&self) -> CoreResult<i64> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let removed = transaction.execute(
            "DELETE FROM memory_vectors WHERE EXISTS ( \
             SELECT 1 FROM memories m WHERE m.id = memory_vectors.memory_id \
             AND (m.forgotten = 1 OR m.superseded_by IS NOT NULL OR m.revision != memory_vectors.revision))",
            [],
        )? as i64;
        transaction.commit()?;
        Ok(removed)
    }
}
