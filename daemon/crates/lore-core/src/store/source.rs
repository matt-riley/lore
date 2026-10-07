//! Source registry, generations, normalized evidence and extraction intent.
//!
//! Capture commits are compare-and-swap transactions keyed on the generation
//! and committed offset: two concurrent captures cannot both advance the same
//! checkpoint, and no offset moves without the normalized records that belong
//! to it landing in the same transaction.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::store::Store;

/// A normalized, role-attributed transcript record captured as evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRecord {
    /// Stable key derived from client/session/record identity and revision.
    pub evidence_key: String,
    /// `session`, `user_turn`, `assistant_turn`, `summary`, `tool` or `checkpoint`.
    pub kind: String,
    pub role: Option<String>,
    pub turn_index: Option<i64>,
    pub parent_key: Option<String>,
    pub branch: Option<String>,
    pub text: String,
    pub completeness: String,
    pub revision: i64,
}

/// A durable source row.
#[derive(Debug, Clone)]
pub struct SourceRow {
    pub source_id: String,
    pub client: String,
    pub root_id: String,
    pub native_session_id: Option<String>,
    pub canonical_path: String,
    pub repository: Option<String>,
    pub repository_verified: bool,
    pub generation: String,
    pub generation_seq: i64,
    pub state: String,
    pub observed_size: i64,
    pub offset: i64,
    pub prefix_hash: Option<String>,
    pub boundary_hash: Option<String>,
    pub parser_version: String,
    pub skipped_records: i64,
    pub pending_bytes: i64,
    pub last_progress_ms: Option<i64>,
    pub last_error: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// Approved root state used by the discovery sweep.
#[derive(Debug, Clone)]
pub struct SourceRootRow {
    pub root_id: String,
    pub client: String,
    pub path: String,
    pub repository: Option<String>,
    pub cursor: Option<String>,
    pub complete: bool,
    pub updated_ms: i64,
}

/// Outcome of one atomic capture commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureOutcome {
    pub inserted: usize,
    pub updated: usize,
    pub generation_changed: bool,
}

/// The exact checkpoint a capture expected, plus everything it captured.
#[derive(Debug, Clone)]
pub struct CaptureCommit {
    pub source_id: String,
    pub expected_generation: String,
    pub expected_offset: i64,
    pub generation: String,
    pub generation_seq: i64,
    pub observed_size: i64,
    pub offset: i64,
    pub prefix_hash: Option<String>,
    pub boundary_hash: Option<String>,
    pub parser_version: String,
    pub state: String,
    pub skipped_records: i64,
    pub pending_bytes: i64,
    pub last_error: Option<String>,
    pub records: Vec<SourceRecord>,
    /// Evidence completeness corrections applied to previously captured rows.
    pub corrections: std::collections::HashMap<String, String>,
    /// Serialized parser state for the next quantum.
    pub parser_state: String,
    /// `(generation, disposition)` retired by this commit, if any.
    pub retire: Option<(String, String)>,
    pub now_ms: i64,
}

/// Source filters for paginated status.
#[derive(Debug, Clone, Default)]
pub struct SourceFilter {
    pub client: Option<String>,
    pub repository: Option<String>,
}

const SOURCE_COLUMNS: &str = "source_id, client, root_id, native_session_id, canonical_path, \
     repository, repository_verified, generation, generation_seq, state, observed_size, offset, \
     prefix_hash, boundary_hash, parser_version, skipped_records, pending_bytes, last_progress_ms, \
     last_error, created_ms, updated_ms";

fn source_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceRow> {
    Ok(SourceRow {
        source_id: row.get(0)?,
        client: row.get(1)?,
        root_id: row.get(2)?,
        native_session_id: row.get(3)?,
        canonical_path: row.get(4)?,
        repository: row.get(5)?,
        repository_verified: row.get::<_, i64>(6)? != 0,
        generation: row.get(7)?,
        generation_seq: row.get(8)?,
        state: row.get(9)?,
        observed_size: row.get(10)?,
        offset: row.get(11)?,
        prefix_hash: row.get(12)?,
        boundary_hash: row.get(13)?,
        parser_version: row.get(14)?,
        skipped_records: row.get(15)?,
        pending_bytes: row.get(16)?,
        last_progress_ms: row.get(17)?,
        last_error: row.get(18)?,
        created_ms: row.get(19)?,
        updated_ms: row.get(20)?,
    })
}

impl Store {
    /// Record (or refresh) an approved root from configuration. Roots that no
    /// longer appear in configuration keep their captured sources but stop
    /// being discovered.
    pub fn upsert_source_root(
        &self,
        root_id: &str,
        client: &str,
        path: &str,
        repository: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<()> {
        let connection = self.writer.lock().expect("writer lock");
        connection.execute(
            "INSERT INTO source_roots (root_id, client, path, repository, cursor, complete, observed_ms, updated_ms) \
             VALUES (?1, ?2, ?3, ?4, NULL, 0, ?5, ?5) \
             ON CONFLICT (root_id) DO UPDATE SET client = excluded.client, path = excluded.path, \
             repository = excluded.repository, updated_ms = excluded.updated_ms, \
             complete = CASE WHEN source_roots.path = excluded.path THEN source_roots.complete ELSE 0 END, \
             cursor = CASE WHEN source_roots.path = excluded.path THEN source_roots.cursor ELSE NULL END",
            params![root_id, client, path, repository, now_ms],
        )?;
        Ok(())
    }

    /// Remove approved roots that are no longer configured. Sources remain.
    pub fn prune_source_roots(&self, keep: &[String]) -> CoreResult<()> {
        let connection = self.writer.lock().expect("writer lock");
        let mut statement = connection.prepare("SELECT root_id FROM source_roots")?;
        let existing: Vec<String> = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        drop(statement);
        for root_id in existing {
            if !keep.contains(&root_id) {
                connection.execute("DELETE FROM source_roots WHERE root_id = ?1", params![root_id])?;
            }
        }
        Ok(())
    }

    /// Roots in stable order for round-robin discovery.
    pub fn source_roots(&self) -> CoreResult<Vec<SourceRootRow>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut statement = connection.prepare(
            "SELECT root_id, client, path, repository, cursor, complete, updated_ms \
             FROM source_roots ORDER BY root_id ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(SourceRootRow {
                root_id: row.get(0)?,
                client: row.get(1)?,
                path: row.get(2)?,
                repository: row.get(3)?,
                cursor: row.get(4)?,
                complete: row.get::<_, i64>(5)? != 0,
                updated_ms: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Persist the discovery cursor for one root after a bounded page.
    pub fn set_source_root_cursor(
        &self,
        root_id: &str,
        cursor: Option<&str>,
        complete: bool,
        now_ms: i64,
    ) -> CoreResult<()> {
        let connection = self.writer.lock().expect("writer lock");
        connection.execute(
            "UPDATE source_roots SET cursor = ?2, complete = ?3, observed_ms = ?4, updated_ms = ?4 \
             WHERE root_id = ?1",
            params![root_id, cursor, i64::from(complete), now_ms],
        )?;
        Ok(())
    }

    /// Register a source idempotently. Returns the row and whether it is new.
    #[allow(clippy::too_many_arguments)]
    pub fn register_source(
        &self,
        source_id: &str,
        client: &str,
        root_id: &str,
        native_session_id: Option<&str>,
        canonical_path: &str,
        repository: Option<&str>,
        repository_verified: bool,
        generation: &str,
        parser_version: &str,
        now_ms: i64,
    ) -> CoreResult<(SourceRow, bool)> {
        let connection = self.writer.lock().expect("writer lock");
        let existing = connection
            .query_row(
                &format!("SELECT {SOURCE_COLUMNS} FROM sources WHERE source_id = ?1"),
                params![source_id],
                source_from_row,
            )
            .optional()?;
        if existing.is_some() {
            connection.execute(
                "UPDATE sources SET repository = COALESCE(?2, repository), \
                 repository_verified = CASE WHEN ?3 <> 0 THEN ?3 ELSE repository_verified END, \
                 updated_ms = ?4 WHERE source_id = ?1",
                params![source_id, repository, i64::from(repository_verified), now_ms],
            )?;
            let refreshed = connection.query_row(
                &format!("SELECT {SOURCE_COLUMNS} FROM sources WHERE source_id = ?1"),
                params![source_id],
                source_from_row,
            )?;
            return Ok((refreshed, false));
        }
        connection.execute(
            "INSERT INTO sources (source_id, client, root_id, native_session_id, canonical_path, \
             repository, repository_verified, generation, generation_seq, state, observed_size, offset, \
             prefix_hash, boundary_hash, parser_version, skipped_records, pending_bytes, \
             last_progress_ms, last_error, created_ms, updated_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 'discovered', 0, 0, NULL, NULL, ?9, 0, 0, NULL, NULL, ?10, ?10)",
            params![
                source_id,
                client,
                root_id,
                native_session_id,
                canonical_path,
                repository,
                i64::from(repository_verified),
                generation,
                parser_version,
                now_ms,
            ],
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO source_generations (source_id, generation, started_ms, retired_ms, disposition) \
             VALUES (?1, ?2, ?3, NULL, 'active')",
            params![source_id, generation, now_ms],
        )?;
        let row = connection.query_row(
            &format!("SELECT {SOURCE_COLUMNS} FROM sources WHERE source_id = ?1"),
            params![source_id],
            source_from_row,
        )?;
        Ok((row, true))
    }

    /// Find a source by client and canonical path.
    pub fn source_by_path(&self, client: &str, canonical_path: &str) -> CoreResult<Option<SourceRow>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        Ok(connection
            .query_row(
                &format!(
                    "SELECT {SOURCE_COLUMNS} FROM sources WHERE client = ?1 AND canonical_path = ?2"
                ),
                params![client, canonical_path],
                source_from_row,
            )
            .optional()?)
    }

    /// One source by ID.
    pub fn source_by_id(&self, source_id: &str) -> CoreResult<Option<SourceRow>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        Ok(connection
            .query_row(
                &format!("SELECT {SOURCE_COLUMNS} FROM sources WHERE source_id = ?1"),
                params![source_id],
                source_from_row,
            )
            .optional()?)
    }

    /// Paginated sources in stable source-ID order, optionally filtered.
    pub fn source_page(
        &self,
        filter: &SourceFilter,
        limit: usize,
        cursor: Option<&str>,
    ) -> CoreResult<Vec<SourceRow>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut statement = connection.prepare(
            "SELECT source_id, client, root_id, native_session_id, canonical_path, repository, \
             repository_verified, generation, generation_seq, state, observed_size, offset, \
             prefix_hash, boundary_hash, parser_version, skipped_records, pending_bytes, \
             last_progress_ms, last_error, created_ms, updated_ms \
             FROM sources \
             WHERE (?1 IS NULL OR client = ?1) AND (?2 IS NULL OR repository = ?2) \
             AND (?3 IS NULL OR source_id > ?3) \
             ORDER BY source_id ASC LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![
                filter.client.as_deref(),
                filter.repository.as_deref(),
                cursor,
                limit as i64
            ],
            source_from_row,
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Sources owed a capture check this sweep, oldest update first. Includes
    /// caught-up and unavailable sources so growth and recovery are noticed
    /// even when no hint arrives.
    pub fn source_queue(&self, limit: usize) -> CoreResult<Vec<SourceRow>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut statement = connection.prepare(
            "SELECT source_id, client, root_id, native_session_id, canonical_path, repository, \
             repository_verified, generation, generation_seq, state, observed_size, offset, \
             prefix_hash, boundary_hash, parser_version, skipped_records, pending_bytes, \
             last_progress_ms, last_error, created_ms, updated_ms \
             FROM sources WHERE state IN ('discovered', 'eligible', 'queued', 'growing', 'retry_wait', \
             'caught_up', 'unavailable', 'ambiguous') \
             ORDER BY updated_ms ASC, source_id ASC LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64], source_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Aggregate source counts, reconciled at the supplied observation time.
    pub fn source_counts(&self) -> CoreResult<Vec<(String, i64)>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut statement =
            connection.prepare("SELECT state, COUNT(*) FROM sources GROUP BY state")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Commit one bounded capture quantum under a checkpoint compare-and-swap.
    ///
    /// Returns `None` when the checkpoint moved underneath the capture (the
    /// caller must re-read and re-run); nothing is written in that case.
    pub fn commit_capture(&self, commit: &CaptureCommit) -> CoreResult<Option<CaptureOutcome>> {
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction = connection.transaction()?;
        let current: Option<(String, i64)> = transaction
            .query_row(
                "SELECT generation, offset FROM sources WHERE source_id = ?1",
                params![commit.source_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match current {
            Some((generation, offset))
                if generation == commit.expected_generation && offset == commit.expected_offset => {}
            _ => return Ok(None),
        }

        if let Some((retired, disposition)) = &commit.retire {
            transaction.execute(
                "UPDATE source_generations SET retired_ms = ?3, disposition = ?4 \
                 WHERE source_id = ?1 AND generation = ?2",
                params![commit.source_id, retired, commit.now_ms, disposition],
            )?;
            transaction.execute(
                "UPDATE extraction_intents SET state = 'retired', updated_ms = ?3 \
                 WHERE source_id = ?1 AND generation = ?2",
                params![commit.source_id, retired, commit.now_ms],
            )?;
        }

        transaction.execute(
            "INSERT OR IGNORE INTO source_generations (source_id, generation, started_ms, retired_ms, disposition) \
             VALUES (?1, ?2, ?3, NULL, 'active')",
            params![commit.source_id, commit.generation, commit.now_ms],
        )?;

        let mut inserted = 0usize;
        let mut updated = 0usize;
        {
            let mut upsert = transaction.prepare(
                "INSERT INTO source_records (source_id, generation, evidence_key, kind, role, turn_index, \
                 parent_key, branch, text, completeness, revision, content_hash, captured_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
                 ON CONFLICT (source_id, generation, evidence_key) DO UPDATE SET \
                 text = excluded.text, completeness = excluded.completeness, revision = excluded.revision, \
                 content_hash = excluded.content_hash, captured_ms = excluded.captured_ms \
                 WHERE source_records.revision <> excluded.revision OR source_records.content_hash <> excluded.content_hash \
                 OR source_records.completeness <> excluded.completeness",
            )?;
            for record in &commit.records {
                let content_hash = content_hash(&record.text);
                let existing: i64 = transaction.query_row(
                    "SELECT COUNT(*) FROM source_records WHERE source_id = ?1 AND generation = ?2 AND evidence_key = ?3",
                    params![commit.source_id, commit.generation, record.evidence_key],
                    |row| row.get(0),
                )?;
                let changed = upsert.execute(params![
                    commit.source_id,
                    commit.generation,
                    record.evidence_key,
                    record.kind,
                    record.role,
                    record.turn_index,
                    record.parent_key,
                    record.branch,
                    record.text,
                    record.completeness,
                    record.revision,
                    content_hash,
                    commit.now_ms,
                ])?;
                if changed > 0 {
                    if existing > 0 {
                        updated += 1;
                    } else {
                        inserted += 1;
                    }
                }
            }
        }

        transaction.execute(
            "UPDATE sources SET generation = ?2, generation_seq = ?3, state = ?4, observed_size = ?5, \
             offset = ?6, prefix_hash = ?7, boundary_hash = ?8, parser_version = ?9, \
             skipped_records = ?10, pending_bytes = ?11, parser_state = ?12, last_progress_ms = ?13, \
             last_error = ?14, updated_ms = ?13 WHERE source_id = ?1",
            params![
                commit.source_id,
                commit.generation,
                commit.generation_seq,
                commit.state,
                commit.observed_size,
                commit.offset,
                commit.prefix_hash,
                commit.boundary_hash,
                commit.parser_version,
                commit.skipped_records,
                commit.pending_bytes,
                commit.parser_state,
                commit.now_ms,
                commit.last_error,
            ],
        )?;

        if !commit.corrections.is_empty() {
            let mut correct = transaction.prepare(
                "UPDATE source_records SET completeness = ?4 WHERE source_id = ?1 AND generation = ?2 \
                 AND evidence_key = ?3 AND completeness <> ?4",
            )?;
            for (key, completeness) in &commit.corrections {
                correct.execute(params![commit.source_id, commit.generation, key, completeness])?;
            }
        }

        let pending = if commit.offset < commit.observed_size { "pending" } else { "complete" };
        transaction.execute(
            "INSERT INTO extraction_intents (source_id, generation, state, through_offset, attempts, \
             next_attempt_ms, terminal_reason, updated_ms) VALUES (?1, ?2, ?3, ?4, 0, NULL, NULL, ?5) \
             ON CONFLICT (source_id, generation) DO UPDATE SET state = ?3, through_offset = excluded.through_offset, \
             attempts = 0, next_attempt_ms = NULL, terminal_reason = NULL, updated_ms = ?5",
            params![commit.source_id, commit.generation, pending, commit.offset, commit.now_ms],
        )?;

        transaction.commit()?;
        Ok(Some(CaptureOutcome {
            inserted,
            updated,
            generation_changed: commit.retire.is_some(),
        }))
    }

    /// Serialized parser state for the source's current generation.
    pub fn source_parser_state(
        &self,
        source_id: &str,
        generation: &str,
    ) -> CoreResult<Option<String>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        Ok(connection
            .query_row(
                "SELECT parser_state FROM sources WHERE source_id = ?1 AND generation = ?2",
                params![source_id, generation],
                |row| row.get::<_, Option<String>>(0),
            )?)
    }

    /// Record a capture failure without moving the checkpoint.
    pub fn mark_source_state(
        &self,
        source_id: &str,
        state: &str,
        reason: Option<&str>,
        observed_size: Option<i64>,
        pending_bytes: i64,
        now_ms: i64,
    ) -> CoreResult<()> {
        let connection = self.writer.lock().expect("writer lock");
        connection.execute(
            "UPDATE sources SET state = ?2, last_error = ?3, \
             observed_size = COALESCE(?4, observed_size), pending_bytes = ?5, updated_ms = ?6 \
             WHERE source_id = ?1",
            params![source_id, state, reason, observed_size, pending_bytes, now_ms],
        )?;
        Ok(())
    }

    /// Generation disposition for eligibility decisions (`active`, `retired`,
    /// `superseded`). Unknown generations are not eligible.
    pub fn generation_disposition(
        &self,
        source_id: &str,
        generation: &str,
    ) -> CoreResult<Option<String>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        Ok(connection
            .query_row(
                "SELECT disposition FROM source_generations WHERE source_id = ?1 AND generation = ?2",
                params![source_id, generation],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Normalized records for one source generation, oldest first.
    pub fn source_records(
        &self,
        source_id: &str,
        generation: &str,
        limit: usize,
    ) -> CoreResult<Vec<SourceRecord>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut statement = connection.prepare(
            "SELECT evidence_key, kind, role, turn_index, parent_key, branch, text, completeness, revision \
             FROM source_records WHERE source_id = ?1 AND generation = ?2 \
             ORDER BY COALESCE(turn_index, 0) ASC, evidence_key ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![source_id, generation, limit as i64], |row| {
            Ok(SourceRecord {
                evidence_key: row.get(0)?,
                kind: row.get(1)?,
                role: row.get(2)?,
                turn_index: row.get(3)?,
                parent_key: row.get(4)?,
                branch: row.get(5)?,
                text: row.get(6)?,
                completeness: row.get(7)?,
                revision: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Count normalized records for one source generation.
    pub fn source_record_count(&self, source_id: &str, generation: &str) -> CoreResult<i64> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        Ok(connection.query_row(
            "SELECT COUNT(*) FROM source_records WHERE source_id = ?1 AND generation = ?2",
            params![source_id, generation],
            |row| row.get(0),
        )?)
    }

    /// Pending extraction coverage across all sources.
    pub fn extraction_pending(&self) -> CoreResult<i64> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        Ok(connection.query_row(
            "SELECT COUNT(*) FROM extraction_intents WHERE state IN ('pending', 'retry_wait')",
            [],
            |row| row.get(0),
        )?)
    }
}

/// Content hash used for evidence revisions. SHA-256 of the exact text.
pub fn content_hash(text: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Deterministic source identity from client, root and native identity (or
/// canonical path when a native identity is unavailable).
pub fn source_id_for(client: &str, root_id: &str, identity: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(client.as_bytes());
    hasher.update([0]);
    hasher.update(root_id.as_bytes());
    hasher.update([0]);
    hasher.update(identity.as_bytes());
    format!("src_{}", &format!("{:x}", hasher.finalize())[..32])
}

/// Open a source database read-only. Never used to write host data.
pub fn open_readonly(path: &std::path::Path) -> CoreResult<Connection> {
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
        | rusqlite::OpenFlags::SQLITE_OPEN_URI;
    Connection::open_with_flags(path, flags)
        .map_err(|error| CoreError::precondition("SOURCE_UNREADABLE", format!("{error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_identity_is_stable_and_namespaced() {
        let first = source_id_for("pi", "root-a", "session-1");
        assert_eq!(first, source_id_for("pi", "root-a", "session-1"));
        assert_ne!(first, source_id_for("pi", "root-b", "session-1"));
        assert_ne!(first, source_id_for("codex", "root-a", "session-1"));
        assert!(first.starts_with("src_"));
    }
}
