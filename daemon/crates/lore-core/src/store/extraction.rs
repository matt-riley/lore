//! Proposal application: memory writes, evidence links, suppression and
//! supersession for automatic extraction.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::extraction::{Proposal, memory_id_for};
use crate::store::Store;

/// Outcome of applying one extraction result.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApplyReport {
    pub applied: usize,
    pub duplicates: usize,
    pub retired: usize,
    pub suppressed: usize,
    pub unresolved: usize,
}

/// A claimed extraction intent.
#[derive(Debug, Clone)]
pub struct ExtractionClaim {
    pub source_id: String,
    pub generation: String,
    pub rule_version: String,
    pub lease_token: String,
}

const RECEIPT_OP_EXTRACT: &str = "extraction.apply";

impl Store {
    /// Apply extracted proposals for one source generation. Idempotent:
    /// identical propositions map to one memory ID and re-application only
    /// refreshes evidence links.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_proposals(
        &self,
        source_id: &str,
        generation: &str,
        proposals: &[Proposal],
        now_ms: i64,
    ) -> CoreResult<ApplyReport> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction()?;
        let mut report = ApplyReport::default();
        let mut revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;

        for proposal in proposals {
            if proposal.scope == "unresolved"
                || (proposal.scope != "global" && proposal.repository.is_none())
            {
                report.unresolved += 1;
                continue;
            }
            let memory_id = memory_id_for(proposal);
            let fingerprint = crate::store::content_hash(&proposal.topic_key);
            let suppressed: Option<String> = transaction
                .query_row(
                    "SELECT reason FROM suppressions WHERE scope = ?1 \
                     AND COALESCE(repository, '') = COALESCE(?2, '') \
                     AND (memory_id = ?3 OR fingerprint = ?4) LIMIT 1",
                    params![proposal.scope, proposal.repository, memory_id, fingerprint],
                    |row| row.get(0),
                )
                .optional()?;
            if suppressed.is_some() {
                report.suppressed += 1;
                continue;
            }

            // Retire superseded automatic propositions before inserting the
            // replacement so contradictory guidance never stays active.
            for retired_topic in &proposal.retires {
                let retired_ids: Vec<String> = {
                    let mut statement = transaction.prepare(
                        "SELECT id FROM memories WHERE topic_key = ?1 AND authority = 'auto' \
                         AND forgotten = 0 AND superseded_by IS NULL AND scope = ?2 \
                         AND COALESCE(repository, '') = COALESCE(?3, '')",
                    )?;
                    let rows = statement.query_map(
                        params![retired_topic, proposal.scope, proposal.repository],
                        |row| row.get::<_, String>(0),
                    )?;
                    rows.collect::<Result<_, _>>()?
                };
                for retired_id in retired_ids {
                    transaction.execute(
                        "UPDATE memories SET superseded_by = ?2, updated_ms = ?3, revision = revision + 1 \
                         WHERE id = ?1",
                        params![retired_id, memory_id, now_ms],
                    )?;
                    transaction.execute(
                        "DELETE FROM memory_fts WHERE memory_id = ?1",
                        params![retired_id],
                    )?;
                    transaction.execute(
                        "UPDATE memory_evidence SET retired_ms = ?2 WHERE memory_id = ?1",
                        params![retired_id, now_ms],
                    )?;
                    report.retired += 1;
                }
            }

            let tags = vec![proposal.kind.clone(), proposal.source_role.clone()];
            let tags_json = serde_json::to_string(&tags)?;
            let inserted = transaction.execute(
                "INSERT INTO memories (id, kind, content, content_hash, scope, repository, authority, \
                 confidence, tags_json, source_session_id, created_ms, updated_ms, expires_at_ms, revision, \
                 forgotten, topic_key) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'auto', ?7, ?8, NULL, ?9, ?9, NULL, ?10, 0, ?11) \
                 ON CONFLICT (id) DO NOTHING",
                params![
                    memory_id,
                    proposal.kind,
                    proposal.content,
                    crate::store::content_hash(&proposal.content),
                    proposal.scope,
                    proposal.repository,
                    proposal.confidence,
                    tags_json,
                    now_ms,
                    revision + 1,
                    proposal.topic_key,
                ],
            )?;
            if inserted > 0 {
                report.applied += 1;
                revision += 1;
                transaction.execute(
                    "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, ?2, ?3, ?4)",
                    params![proposal.content, proposal.kind, tags.join(" "), memory_id],
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
                        crate::store::content_hash(&proposal.content),
                        self.embedding_identity.as_deref().unwrap_or(""),
                        now_ms
                    ],
                )?;
            } else {
                report.duplicates += 1;
            }

            let evidence_key = if proposal.evidence_key.is_empty() {
                proposal.topic_key.clone()
            } else {
                proposal.evidence_key.clone()
            };
            transaction.execute(
                "INSERT INTO memory_evidence (memory_id, source_id, generation, evidence_key, role, created_ms, retired_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL) \
                 ON CONFLICT (memory_id, source_id, generation, evidence_key) DO UPDATE SET \
                 retired_ms = NULL, created_ms = excluded.created_ms",
                params![
                    memory_id,
                    source_id,
                    generation,
                    evidence_key,
                    proposal.source_role,
                    now_ms
                ],
            )?;
        }

        if revision > 0 {
            transaction.execute(
                "UPDATE store_metadata SET memory_revision = ?1 WHERE id = 1",
                params![revision],
            )?;
        }
        let active: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL",
            [],
            |row| row.get(0),
        )?;
        transaction.execute(
            "UPDATE store_metadata SET active_memories = ?1 WHERE id = 1",
            params![active],
        )?;
        transaction.commit()?;
        Ok(report)
    }

    /// Claim the next extraction intent with a lease. Returns `None` when no
    /// work is due.
    pub fn claim_extraction_intent(
        &self,
        owner: &str,
        rule_version: &str,
        lease_ms: i64,
        now_ms: i64,
    ) -> CoreResult<Option<ExtractionClaim>> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction()?;
        let candidate: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT source_id, generation, rule_version FROM extraction_intents \
                 WHERE (state IN ('pending', 'retry_wait') OR (state = 'running' AND lease_expires_ms < ?1)) \
                 AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?1) \
                 ORDER BY updated_ms ASC LIMIT 1",
                params![now_ms],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((source_id, generation, stored_version)) = candidate else {
            return Ok(None);
        };
        let lease_token = uuid::Uuid::new_v4().to_string();
        // A rule-version change on existing evidence is an explicit
        // reprocessing decision, not an automatic rewrite; the stored version
        // is preserved and reported through `ruleVersion`.
        let effective_version = if stored_version.is_empty() {
            rule_version.to_string()
        } else {
            stored_version
        };
        transaction.execute(
            "UPDATE extraction_intents SET state = 'running', lease_token = ?3, lease_owner = ?4, \
             lease_expires_ms = ?5, updated_ms = ?6 WHERE source_id = ?1 AND generation = ?2",
            params![
                source_id,
                generation,
                lease_token,
                owner,
                now_ms + lease_ms,
                now_ms
            ],
        )?;
        transaction.commit()?;
        Ok(Some(ExtractionClaim {
            source_id,
            generation,
            rule_version: effective_version,
            lease_token,
        }))
    }

    /// Finish a claimed intent. Stale leases are rejected.
    pub fn complete_extraction(
        &self,
        claim: &ExtractionClaim,
        applied: usize,
        now_ms: i64,
    ) -> CoreResult<bool> {
        let connection = self.writer.lock().expect("writer lock");
        let changed = connection.execute(
            "UPDATE extraction_intents SET state = 'complete', rule_version = ?4, lease_token = NULL, \
             lease_owner = NULL, lease_expires_ms = NULL, attempts = 0, next_attempt_ms = NULL, \
             updated_ms = ?5, terminal_reason = ?6 \
             WHERE source_id = ?1 AND generation = ?2 AND lease_token = ?3",
            params![
                claim.source_id,
                claim.generation,
                claim.lease_token,
                claim.rule_version,
                now_ms,
                format!("applied:{applied}")
            ],
        )?;
        Ok(changed > 0)
    }

    /// Release a failed claim with bounded backoff; the attempt budget never
    /// resets without an explicit retry.
    pub fn fail_extraction(
        &self,
        claim: &ExtractionClaim,
        reason: &str,
        now_ms: i64,
    ) -> CoreResult<bool> {
        let connection = self.writer.lock().expect("writer lock");
        let attempts: i64 = connection
            .query_row(
                "SELECT attempts FROM extraction_intents WHERE source_id = ?1 AND generation = ?2",
                params![claim.source_id, claim.generation],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0)
            + 1;
        let backoff = crate::store::jittered_backoff_ms(attempts, 1_000, 60_000, now_ms as u64);
        let changed = connection.execute(
            "UPDATE extraction_intents SET state = 'retry_wait', attempts = ?4, \
             next_attempt_ms = ?5, lease_token = NULL, lease_owner = NULL, lease_expires_ms = NULL, \
             updated_ms = ?6, terminal_reason = ?7 \
             WHERE source_id = ?1 AND generation = ?2 AND lease_token = ?3",
            params![
                claim.source_id,
                claim.generation,
                claim.lease_token,
                attempts,
                now_ms + backoff,
                now_ms,
                reason
            ],
        )?;
        Ok(changed > 0)
    }

    /// Explicit reprocessing: reschedule every completed or failed intent
    /// under the requested rule version. Existing evidence is not rewritten
    /// without this call; the result is idempotent because propositions keep
    /// stable identity.
    pub fn reset_extraction_intents(&self, rule_version: &str, now_ms: i64) -> CoreResult<u64> {
        let connection = self.writer.lock().expect("writer lock");
        let changed = connection.execute(
            "UPDATE extraction_intents SET state = 'pending', rule_version = ?1, attempts = 0, \
             next_attempt_ms = NULL, terminal_reason = NULL, updated_ms = ?2 \
             WHERE state IN ('complete', 'failed', 'pending', 'retry_wait')",
            params![rule_version, now_ms],
        )?;
        Ok(changed as u64)
    }

    /// Count intents by state for diagnostics.
    pub fn extraction_counts(&self) -> CoreResult<Vec<(String, i64)>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut statement =
            connection.prepare("SELECT state, COUNT(*) FROM extraction_intents GROUP BY state")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<Result<_, _>>().map_err(CoreError::from)
    }

    /// Evidence links for one memory.
    pub fn memory_evidence(&self, memory_id: &str) -> CoreResult<Vec<(String, String, String)>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut statement = connection.prepare(
            "SELECT source_id, generation, evidence_key FROM memory_evidence \
             WHERE memory_id = ?1 ORDER BY evidence_key ASC",
        )?;
        let rows = statement.query_map(params![memory_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect::<Result<_, _>>().map_err(CoreError::from)
    }

    /// Idempotency helper for repeated apply attempts of the same run.
    pub fn extraction_receipt(
        &self,
        source_id: &str,
        generation: &str,
        rule_version: &str,
    ) -> CoreResult<Option<String>> {
        let key = format!("{source_id}\u{1}{generation}\u{1}{rule_version}");
        self.lookup_receipt_json("extractor", RECEIPT_OP_EXTRACT, &key)
            .map(|value| value.map(|(_, response)| response))
    }

    /// Record a completed apply for the run idempotency key.
    pub fn store_extraction_receipt(
        &self,
        source_id: &str,
        generation: &str,
        rule_version: &str,
        response: &str,
        now_ms: i64,
    ) -> CoreResult<()> {
        let key = format!("{source_id}\u{1}{generation}\u{1}{rule_version}");
        let hash = crate::policy::sha256_hex(key.as_bytes());
        self.store_receipt_json(
            "extractor",
            RECEIPT_OP_EXTRACT,
            &key,
            &hash,
            response,
            now_ms,
        )
    }
}
