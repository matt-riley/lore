//! Embedding intents, materialized jobs, vectors and coverage counters.
//!
//! Child module of `store`: it can reuse the writer/readers and private
//! helpers. Every state transition is fenced by lease token, owner, target
//! revision/hash, model identity and current eligibility.

use rusqlite::types::Value;
use rusqlite::{OptionalExtension, TransactionBehavior, params, params_from_iter};
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};

use super::Store;

/// One handed-out job with everything the caller needs to embed it.
#[derive(Debug, Clone)]
pub struct ClaimedJob {
    pub job_id: String,
    pub memory_id: String,
    pub target_revision: i64,
    pub target_hash: String,
    pub content: String,
    pub attempts: i64,
    pub lease_token: String,
}

/// Outcome of a completion attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompleteOutcome {
    Stored,
    Obsolete,
}

/// Terminal/retry state after a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailOutcome {
    RetryScheduled,
    Terminal,
}

/// Counters for Status and the jobs route.
#[derive(Debug, Clone, Default)]
pub struct EmbeddingCounts {
    pub current_vectors: i64,
    pub eligible_memories: i64,
    pub pending: i64,
    pub failed: i64,
    pub queued: i64,
    pub running: i64,
    pub retry_wait: i64,
    pub oldest_pending_ms: Option<i64>,
}

/// One page of reconciliation work.
#[derive(Debug, Clone)]
pub struct ReconcilePage {
    pub queued: i64,
    pub next_cursor: Option<String>,
}

/// A stored vector row used for scoring.
#[derive(Debug, Clone)]
pub struct StoredVector {
    pub memory_id: String,
    pub vector: Vec<f32>,
    pub norm: f64,
}

/// One job row for the jobs route.
#[derive(Debug, Clone)]
pub struct JobView {
    pub job_id: String,
    pub memory_id: String,
    pub state: String,
    pub attempts: i64,
    pub next_attempt_ms: Option<i64>,
    pub terminal_reason: Option<String>,
}

/// Encode an f32 vector little-endian for storage.
pub fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

/// Decode a little-endian f32 vector, rejecting truncated blobs.
pub fn blob_to_vector(blob: &[u8]) -> Option<Vec<f32>> {
    if !blob.len().is_multiple_of(4) {
        return None;
    }
    Some(
        blob.as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| f32::from_le_bytes(*chunk))
            .collect(),
    )
}

/// Euclidean norm with finite validation.
pub fn vector_norm(vector: &[f32]) -> f64 {
    vector
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt()
}

/// Cosine similarity; returns zero when either side has no usable norm.
pub fn cosine(query: &[f32], query_norm: f64, stored: &[f32], stored_norm: f64) -> f64 {
    if query.len() != stored.len() || query_norm <= 0.0 || stored_norm <= 0.0 {
        return 0.0;
    }
    let dot: f64 = query
        .iter()
        .zip(stored)
        .map(|(left, right)| f64::from(*left) * f64::from(*right))
        .sum();
    let similarity = dot / (query_norm * stored_norm);
    if similarity.is_finite() {
        similarity.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

/// Full-jitter exponential backoff, deterministic for a given seed.
pub fn jittered_backoff_ms(attempt: i64, base_ms: i64, cap_ms: i64, seed: u64) -> i64 {
    let exponent = attempt.clamp(1, 10) as u32;
    let ceiling = (base_ms.saturating_mul(1_i64 << exponent.min(20)))
        .min(cap_ms)
        .max(1);
    let mixed = seed
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    (mixed % ceiling as u64) as i64
}

impl Store {
    /// Reconcile one bounded keyset page of eligible memories into intents
    /// and materialized jobs. Never resets terminal failures.
    pub fn reconcile_page(
        &self,
        identity: &str,
        after: Option<&str>,
        page: usize,
        now_ms: i64,
    ) -> CoreResult<ReconcilePage> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = transaction.prepare(
            "SELECT id, revision, content_hash FROM memories \
             WHERE forgotten = 0 AND superseded_by IS NULL \
             AND (expires_at_ms IS NULL OR expires_at_ms > ?1) AND id > ?2 \
             ORDER BY id ASC LIMIT ?3",
        )?;
        let rows: Vec<(String, i64, String)> = statement
            .query_map(params![now_ms, after.unwrap_or(""), page as i64], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<_, _>>()?;
        drop(statement);

        let mut queued = 0i64;
        let mut next_cursor = None;
        for (memory_id, revision, content_hash) in &rows {
            next_cursor = Some(memory_id.clone());
            transaction.execute(
                "INSERT INTO embedding_intents \
                 (memory_id, desired_revision, state, attempts, next_attempt_ms, terminal_reason, content_hash, model_identity, updated_ms) \
                 VALUES (?1, ?2, 'pending', 0, NULL, NULL, ?3, ?4, ?5) \
                 ON CONFLICT(memory_id) DO UPDATE SET \
                   desired_revision = excluded.desired_revision, \
                   content_hash = excluded.content_hash, \
                   model_identity = excluded.model_identity, \
                   updated_ms = excluded.updated_ms, \
                   state = CASE \
                     WHEN embedding_intents.state = 'current' \
                       AND embedding_intents.desired_revision = excluded.desired_revision \
                       AND embedding_intents.model_identity = excluded.model_identity THEN 'current' \
                     WHEN embedding_intents.state = 'failed' \
                       AND embedding_intents.desired_revision = excluded.desired_revision \
                       AND embedding_intents.model_identity = excluded.model_identity THEN 'failed' \
                     ELSE 'pending' END",
                params![memory_id, revision, content_hash, identity, now_ms],
            )?;
            let inserted = transaction.execute(
                "INSERT INTO embedding_jobs \
                 (job_id, memory_id, target_revision, target_hash, model_identity, state, attempts, next_attempt_ms, updated_ms) \
                 SELECT ?1, ?2, ?3, ?4, ?5, 'queued', 0, NULL, ?6 \
                 WHERE NOT EXISTS (SELECT 1 FROM embedding_jobs \
                   WHERE memory_id = ?2 AND model_identity = ?5 \
                   AND state IN ('queued', 'running', 'retry_wait')) \
                 AND EXISTS (SELECT 1 FROM embedding_intents \
                   WHERE memory_id = ?2 AND state = 'pending')",
                params![
                    Uuid::new_v4().to_string(),
                    memory_id,
                    revision,
                    content_hash,
                    identity,
                    now_ms
                ],
            )?;
            queued += inserted as i64;
        }
        let exhausted = rows.len() < page;
        transaction.execute(
            "UPDATE store_metadata SET reconciliation_cursor = ?1 WHERE id = 1",
            params![if exhausted { None } else { next_cursor.clone() }],
        )?;
        transaction.commit()?;
        Ok(ReconcilePage {
            queued,
            next_cursor: if exhausted { None } else { next_cursor },
        })
    }

    /// Reap claims whose lease expired and mark exhausted retries failed.
    pub fn reap_expired_jobs(&self, now_ms: i64) -> CoreResult<usize> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let failed = transaction.execute(
            "UPDATE embedding_jobs SET state = 'failed', terminal_reason = COALESCE(terminal_reason, 'RETRY_EXHAUSTED'), \
             lease_token = NULL, lease_owner = NULL, lease_expires_ms = NULL, updated_ms = ?1 \
             WHERE state = 'running' AND lease_expires_ms IS NOT NULL AND lease_expires_ms <= ?1 AND attempts >= 5",
            params![now_ms],
        )?;
        let failed_intents = transaction.execute(
            "UPDATE embedding_intents SET state = 'failed', terminal_reason = COALESCE(terminal_reason, 'RETRY_EXHAUSTED'), updated_ms = ?1 \
             WHERE state = 'running' AND NOT EXISTS (SELECT 1 FROM embedding_jobs \
               WHERE embedding_jobs.memory_id = embedding_intents.memory_id AND state IN ('queued', 'running', 'retry_wait'))",
            params![now_ms],
        )?;
        let requeued = transaction.execute(
            "UPDATE embedding_jobs SET state = 'queued', lease_token = NULL, lease_owner = NULL, lease_expires_ms = NULL, updated_ms = ?1 \
             WHERE state = 'running' AND lease_expires_ms IS NOT NULL AND lease_expires_ms <= ?1",
            params![now_ms],
        )?;
        transaction.commit()?;
        Ok(requeued + failed + failed_intents)
    }

    /// Claim one runnable job with a fresh lease token.
    pub fn claim_job(
        &self,
        owner: &str,
        now_ms: i64,
        lease_ms: i64,
    ) -> CoreResult<Option<ClaimedJob>> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let next: Option<(String, String, i64, String, i64)> = transaction
            .query_row(
                "SELECT job_id, memory_id, target_revision, target_hash, attempts FROM embedding_jobs \
                 WHERE state IN ('queued', 'retry_wait') AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?1) \
                 ORDER BY updated_ms ASC, job_id ASC LIMIT 1",
                params![now_ms],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        let Some((job_id, memory_id, revision, hash, attempts)) = next else {
            return Ok(None);
        };
        let lease_token = Uuid::new_v4().to_string();
        let claimed = transaction.execute(
            "UPDATE embedding_jobs SET state = 'running', lease_token = ?1, lease_owner = ?2, \
             lease_expires_ms = ?3, attempts = attempts + 1, updated_ms = ?4 \
             WHERE job_id = ?5 AND state IN ('queued', 'retry_wait')",
            params![lease_token, owner, now_ms + lease_ms, now_ms, job_id],
        )?;
        if claimed == 0 {
            return Ok(None);
        }
        let content: Option<String> = transaction
            .query_row(
                "SELECT content FROM memories WHERE id = ?1 AND forgotten = 0 \
                 AND superseded_by IS NULL AND revision = ?2 AND content_hash = ?3 \
                 AND (expires_at_ms IS NULL OR expires_at_ms > ?4)",
                params![memory_id, revision, hash, now_ms],
                |row| row.get(0),
            )
            .optional()?;
        let Some(content) = content else {
            transaction.execute(
                "UPDATE embedding_jobs SET state = 'obsolete', lease_token = NULL, lease_owner = NULL, \
                 lease_expires_ms = NULL, updated_ms = ?1 WHERE job_id = ?2",
                params![now_ms, job_id],
            )?;
            transaction.commit()?;
            return Ok(None);
        };
        transaction.execute(
            "UPDATE embedding_intents SET state = 'running', updated_ms = ?1 WHERE memory_id = ?2",
            params![now_ms, memory_id],
        )?;
        transaction.commit()?;
        Ok(Some(ClaimedJob {
            job_id,
            memory_id,
            target_revision: revision,
            target_hash: hash,
            content,
            attempts: attempts + 1,
            lease_token,
        }))
    }

    /// Extend a live lease. Returns false when fencing fails.
    pub fn renew_job(
        &self,
        job_id: &str,
        lease_token: &str,
        owner: &str,
        now_ms: i64,
        lease_ms: i64,
    ) -> CoreResult<bool> {
        let connection = self.writer.lock().expect("writer lock");
        let updated = connection.execute(
            "UPDATE embedding_jobs SET lease_expires_ms = ?1, updated_ms = ?2 \
             WHERE job_id = ?3 AND state = 'running' AND lease_token = ?4 AND lease_owner = ?5 \
             AND lease_expires_ms > ?2",
            params![now_ms + lease_ms, now_ms, job_id, lease_token, owner],
        )?;
        Ok(updated == 1)
    }

    /// Fenced completion: verifies lease, target identity and eligibility
    /// before storing one vector and closing the intent and job together.
    pub fn complete_job(
        &self,
        job_id: &str,
        lease_token: &str,
        owner: &str,
        vector: &[f32],
        now_ms: i64,
    ) -> CoreResult<CompleteOutcome> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, i64, String, String)> = transaction
            .query_row(
                "SELECT memory_id, target_revision, target_hash, model_identity FROM embedding_jobs \
                 WHERE job_id = ?1 AND state = 'running' AND lease_token = ?2 AND lease_owner = ?3 \
                 AND lease_expires_ms > ?4",
                params![job_id, lease_token, owner, now_ms],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((memory_id, revision, hash, identity)) = row else {
            return Ok(CompleteOutcome::Obsolete);
        };
        let current: Option<(i64, String)> = transaction
            .query_row(
                "SELECT revision, content_hash FROM memories WHERE id = ?1 AND forgotten = 0 \
                 AND superseded_by IS NULL AND (expires_at_ms IS NULL OR expires_at_ms > ?2)",
                params![memory_id, now_ms],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let matches = matches!(current, Some((revision_now, hash_now)) if revision_now == revision && hash_now == hash);
        if !matches {
            transaction.execute(
                "UPDATE embedding_jobs SET state = 'obsolete', lease_token = NULL, lease_owner = NULL, \
                 lease_expires_ms = NULL, updated_ms = ?1 WHERE job_id = ?2",
                params![now_ms, job_id],
            )?;
            transaction.commit()?;
            return Ok(CompleteOutcome::Obsolete);
        }
        let norm = vector_norm(vector);
        if norm <= 0.0 || !norm.is_finite() {
            return Err(CoreError::invalid(
                "INVALID_VECTOR",
                "provider vector has no usable norm",
            ));
        }
        transaction.execute(
            "INSERT INTO memory_vectors \
             (memory_id, revision, content_hash, model_identity, dimensions, norm, vector, created_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(memory_id, model_identity) DO UPDATE SET \
               revision = excluded.revision, content_hash = excluded.content_hash, \
               dimensions = excluded.dimensions, norm = excluded.norm, \
               vector = excluded.vector, created_ms = excluded.created_ms",
            params![
                memory_id,
                revision,
                hash,
                identity,
                vector.len() as i64,
                norm,
                vector_to_blob(vector),
                now_ms
            ],
        )?;
        transaction.execute(
            "UPDATE embedding_intents SET state = 'current', attempts = 0, next_attempt_ms = NULL, \
             terminal_reason = NULL, updated_ms = ?1 WHERE memory_id = ?2",
            params![now_ms, memory_id],
        )?;
        transaction.execute(
            "UPDATE embedding_jobs SET state = 'complete', lease_token = NULL, lease_owner = NULL, \
             lease_expires_ms = NULL, updated_ms = ?1 WHERE job_id = ?2",
            params![now_ms, job_id],
        )?;
        transaction.commit()?;
        Ok(CompleteOutcome::Stored)
    }

    /// Record a failure: schedule a retry within budget or go terminal.
    #[allow(clippy::too_many_arguments)]
    pub fn fail_job(
        &self,
        job_id: &str,
        lease_token: &str,
        owner: &str,
        category: &str,
        retryable: bool,
        backoff_ms: Option<i64>,
        now_ms: i64,
    ) -> CoreResult<FailOutcome> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, i64)> = transaction
            .query_row(
                "SELECT memory_id, attempts FROM embedding_jobs \
                 WHERE job_id = ?1 AND state = 'running' AND lease_token = ?2 AND lease_owner = ?3",
                params![job_id, lease_token, owner],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((memory_id, attempts)) = row else {
            return Ok(FailOutcome::Terminal);
        };
        if retryable && attempts < 5 {
            transaction.execute(
                "UPDATE embedding_jobs SET state = 'retry_wait', next_attempt_ms = ?1, \
                 lease_token = NULL, lease_owner = NULL, lease_expires_ms = NULL, updated_ms = ?2 \
                 WHERE job_id = ?3",
                params![now_ms + backoff_ms.unwrap_or(1_000), now_ms, job_id],
            )?;
            transaction.execute(
                "UPDATE embedding_intents SET state = 'retry_wait', attempts = ?1, next_attempt_ms = ?2, \
                 terminal_reason = ?3, updated_ms = ?4 WHERE memory_id = ?5",
                params![attempts, now_ms + backoff_ms.unwrap_or(1_000), category, now_ms, memory_id],
            )?;
            transaction.commit()?;
            Ok(FailOutcome::RetryScheduled)
        } else {
            transaction.execute(
                "UPDATE embedding_jobs SET state = 'failed', terminal_reason = ?1, \
                 lease_token = NULL, lease_owner = NULL, lease_expires_ms = NULL, updated_ms = ?2 \
                 WHERE job_id = ?3",
                params![category, now_ms, job_id],
            )?;
            transaction.execute(
                "UPDATE embedding_intents SET state = 'failed', attempts = ?1, terminal_reason = ?2, \
                 updated_ms = ?3 WHERE memory_id = ?4",
                params![attempts, category, now_ms, memory_id],
            )?;
            transaction.commit()?;
            Ok(FailOutcome::Terminal)
        }
    }

    /// Coverage and queue counters for Status and the jobs route.
    pub fn embedding_counts(&self, identity: &str, now_ms: i64) -> CoreResult<EmbeddingCounts> {
        let connection = self.writer.lock().expect("writer lock");
        let eligible: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL \
             AND (expires_at_ms IS NULL OR expires_at_ms > ?1)",
            params![now_ms],
            |row| row.get(0),
        )?;
        let current_vectors: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memory_vectors v JOIN memories m ON m.id = v.memory_id \
             WHERE v.model_identity = ?1 AND v.revision = m.revision AND v.content_hash = m.content_hash \
             AND m.forgotten = 0 AND m.superseded_by IS NULL \
             AND (m.expires_at_ms IS NULL OR m.expires_at_ms > ?2)",
            params![identity, now_ms],
            |row| row.get(0),
        )?;
        let pending: i64 = connection.query_row(
            "SELECT COUNT(*) FROM embedding_intents WHERE state IN ('pending', 'queued', 'retry_wait', 'running')",
            [],
            |row| row.get(0),
        )?;
        let failed: i64 = connection.query_row(
            "SELECT COUNT(*) FROM embedding_intents WHERE state = 'failed'",
            [],
            |row| row.get(0),
        )?;
        let oldest: Option<i64> = connection.query_row(
            "SELECT MIN(updated_ms) FROM embedding_intents WHERE state IN ('pending', 'queued', 'retry_wait', 'running')",
            [],
            |row| row.get(0),
        )?;
        let count_state = |state: &str| -> CoreResult<i64> {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM embedding_jobs WHERE state = ?1",
                params![state],
                |row| row.get(0),
            )?)
        };
        Ok(EmbeddingCounts {
            current_vectors,
            eligible_memories: eligible,
            pending,
            failed,
            queued: count_state("queued")?,
            running: count_state("running")?,
            retry_wait: count_state("retry_wait")?,
            oldest_pending_ms: oldest,
        })
    }

    /// Page eligible stored vectors in stable memory-ID order.
    #[allow(clippy::too_many_arguments)]
    pub fn vector_page(
        &self,
        connection: &rusqlite::Connection,
        identity: &str,
        after: Option<&str>,
        limit: usize,
        repository: Option<&str>,
        include_other_repositories: bool,
        now_ms: i64,
    ) -> CoreResult<Vec<StoredVector>> {
        let mut sql = String::from(
            "SELECT v.memory_id, v.vector FROM memory_vectors v JOIN memories m ON m.id = v.memory_id \
             WHERE v.model_identity = ?1 AND v.revision = m.revision AND v.content_hash = m.content_hash \
             AND m.forgotten = 0 AND m.superseded_by IS NULL \
             AND (m.expires_at_ms IS NULL OR m.expires_at_ms > ?2) AND m.id > ?3",
        );
        let mut values: Vec<Value> = vec![
            Value::Text(identity.to_string()),
            Value::Integer(now_ms),
            Value::Text(after.unwrap_or("").to_string()),
        ];
        match repository {
            None => sql.push_str(" AND m.scope = 'global'"),
            Some(repo) => {
                sql.push_str(
                    " AND (m.scope = 'global' OR m.repository = ?4 \
                     OR (?5 = 1 AND m.scope = 'transferable' AND m.repository <> ?4))",
                );
                values.push(Value::Text(repo.to_string()));
                values.push(Value::Integer(i64::from(include_other_repositories)));
            }
        }
        sql.push_str(" ORDER BY m.id ASC LIMIT ?");
        values.push(Value::Integer(limit as i64));

        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values.iter()), |row| {
            let blob: Vec<u8> = row.get(1)?;
            Ok((row.get::<_, String>(0)?, blob))
        })?;
        let mut vectors = Vec::new();
        for row in rows {
            let (memory_id, blob) = row?;
            if let Some(vector) = blob_to_vector(&blob) {
                vectors.push(StoredVector {
                    memory_id,
                    vector,
                    norm: 0.0,
                });
            }
        }
        Ok(vectors)
    }

    /// List jobs for the jobs route, optionally filtered by state.
    pub fn list_jobs(
        &self,
        state: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> CoreResult<Vec<JobView>> {
        let connection = self.writer.lock().expect("writer lock");
        let mut statement = connection.prepare(
            "SELECT job_id, memory_id, state, attempts, next_attempt_ms, terminal_reason FROM embedding_jobs \
             WHERE (?1 IS NULL OR state = ?1) AND job_id > ?2 \
             ORDER BY job_id ASC LIMIT ?3",
        )?;
        let rows =
            statement.query_map(params![state, after.unwrap_or(""), limit as i64], |row| {
                Ok(JobView {
                    job_id: row.get(0)?,
                    memory_id: row.get(1)?,
                    state: row.get(2)?,
                    attempts: row.get(3)?,
                    next_attempt_ms: row.get(4)?,
                    terminal_reason: row.get(5)?,
                })
            })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Reset terminal failures after an explicit operator retry.
    pub fn retry_failed_jobs(
        &self,
        identity: Option<&str>,
        memory_ids: Option<&[String]>,
        now_ms: i64,
    ) -> CoreResult<u64> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut sql = String::from(
            "UPDATE embedding_jobs SET state = 'queued', attempts = 0, next_attempt_ms = NULL, \
             terminal_reason = NULL, updated_ms = ?1 WHERE state = 'failed' \
             AND (?2 IS NULL OR model_identity = ?2)",
        );
        let mut values: Vec<Value> = vec![Value::Integer(now_ms)];
        values.push(identity.map_or(Value::Null, |value| Value::Text(value.to_string())));
        if let Some(ids) = memory_ids
            && !ids.is_empty()
        {
            let placeholders = vec!["?"; ids.len()].join(", ");
            sql.push_str(&format!(" AND memory_id IN ({placeholders})"));
            values.extend(ids.iter().map(|id| Value::Text(id.clone())));
        }
        let reset = transaction.execute(&sql, params_from_iter(values.iter()))? as u64;
        transaction.execute(
            "UPDATE embedding_intents SET state = 'pending', attempts = 0, next_attempt_ms = NULL, \
             terminal_reason = NULL, updated_ms = ?1 WHERE state = 'failed' \
             AND (?2 IS NULL OR model_identity = ?2)",
            params![now_ms, identity],
        )?;
        transaction.commit()?;
        Ok(reset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vectors_round_trip_little_endian() {
        let vector = vec![1.5f32, -2.25, 0.0, 3.0];
        let blob = vector_to_blob(&vector);
        assert_eq!(blob.len(), 16);
        assert_eq!(blob_to_vector(&blob).expect("decode"), vector);
        assert!(blob_to_vector(&[0, 1, 2]).is_none());
    }

    #[test]
    fn cosine_is_bounded_and_zero_safe() {
        assert!((cosine(&[1.0, 0.0], 1.0, &[1.0, 0.0], 1.0) - 1.0).abs() < 1e-9);
        assert!(cosine(&[1.0, 0.0], 1.0, &[0.0, 0.0], 0.0).abs() < 1e-9);
        assert!(cosine(&[1.0], 1.0, &[1.0, 2.0], 1.0).abs() < 1e-9);
    }

    #[test]
    fn backoff_is_bounded_and_deterministic() {
        let first = jittered_backoff_ms(1, 1_000, 60_000, 42);
        assert_eq!(first, jittered_backoff_ms(1, 1_000, 60_000, 42));
        assert!((0..=2_000).contains(&first));
        assert!(jittered_backoff_ms(5, 1_000, 60_000, 42) <= 32_000);
        assert!(jittered_backoff_ms(9, 1_000, 60_000, 42) <= 60_000);
    }
}
