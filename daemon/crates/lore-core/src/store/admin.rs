//! Read-only administration operations: lexical search, explanation,
//! validation, doctor, extraction audit and capability inventory.
//!
//! These are bounded synchronous reads. They never persist query text and
//! never mutate store state.

use rusqlite::params_from_iter;
use serde_json::{Value, json};

use crate::error::{CoreError, CoreResult};
use crate::store::{Store, parse_scope};

/// Bounded page size for administrative browsing.
pub const ADMIN_PAGE_DEFAULT: u32 = 50;
pub const ADMIN_PAGE_MAX: u32 = 200;

impl Store {
    /// Lexical browsing with explicit scope selection and keyset pagination.
    /// Suppression, expiry and supersession always apply to active results.
    #[allow(clippy::too_many_arguments)]
    pub fn admin_search(
        &self,
        query: &str,
        repository: Option<&str>,
        include_other_repositories: bool,
        cursor: Option<&str>,
        limit: u32,
        now_ms: i64,
    ) -> CoreResult<Value> {
        let terms = crate::retrieval::extract_terms(query);
        if terms.is_empty() {
            return Ok(json!({ "items": [], "nextCursor": null, "query": query }));
        }
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let fts = crate::retrieval::fts_query(&terms);
        let limit = limit.clamp(1, ADMIN_PAGE_MAX);
        let mut sql = String::from(
            "SELECT m.id, m.kind, m.content, m.scope, m.repository, m.authority, m.confidence, \
             m.updated_ms, bm25(memory_fts) AS rank \
             FROM memory_fts JOIN memories m ON m.id = memory_fts.memory_id \
             WHERE memory_fts MATCH ?1 AND m.forgotten = 0 AND m.superseded_by IS NULL \
             AND (m.expires_at_ms IS NULL OR m.expires_at_ms > ?2)",
        );
        let mut values: Vec<rusqlite::types::Value> = vec![fts.into(), now_ms.into()];
        match repository {
            None => sql.push_str(" AND m.scope = 'global'"),
            Some(repository) => {
                if include_other_repositories {
                    sql.push_str(" AND (m.scope = 'global' OR m.repository IS NOT NULL)");
                } else {
                    sql.push_str(" AND (m.scope = 'global' OR m.repository = ?3)");
                    values.push(repository.to_string().into());
                }
            }
        }
        if let Some(cursor) = cursor {
            sql.push_str(" AND m.id > ?");
            values.push(cursor.to_string().into());
        }
        sql.push_str(" ORDER BY m.id ASC LIMIT ?");
        values.push(((limit + 1) as i64).into());
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values.iter()), |row| {
            let scope: String = row.get(3)?;
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
                "content": row.get::<_, String>(2)?,
                "scope": parse_scope(&scope),
                "repository": row.get::<_, Option<String>>(4)?,
                "authority": row.get::<_, String>(5)?,
                "confidence": row.get::<_, f64>(6)?,
                "updatedMs": row.get::<_, i64>(7)?,
                "rank": row.get::<_, f64>(8)?,
            }))
        })?;
        let mut items: Vec<Value> = rows.collect::<Result<_, _>>()?;
        let next_cursor = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items
                .last()
                .and_then(|item| item["id"].as_str())
                .map(str::to_string)
        } else {
            None
        };
        Ok(json!({
            "items": items,
            "nextCursor": next_cursor,
            "query": query,
            "administrative": include_other_repositories,
        }))
    }

    /// Explanation of the context Recall would assemble, with represented IDs
    /// and bounded diagnostic reasons. No query text is persisted.
    #[allow(clippy::too_many_arguments)]
    pub fn admin_explain(
        &self,
        query: &str,
        repository: Option<&str>,
        include_other_repositories: bool,
        limit: u32,
        context_bytes: u32,
        now_ms: i64,
    ) -> CoreResult<Value> {
        let params = protocol::RecallParams {
            query: query.to_string(),
            repository: repository.map(str::to_string),
            include_other_repositories,
            limit: Some(limit),
            context_bytes: Some(context_bytes),
        };
        let result = self.recall(
            &params,
            now_ms,
            limit.clamp(1, self.limits.max_results),
            context_bytes,
            None,
        )?;
        let sections: Vec<Value> = result
            .sections
            .iter()
            .map(|section| {
                json!({
                    "id": section.id,
                    "memoryIds": section.memory_ids,
                    "text": section.text,
                    "omitted": section.omitted,
                })
            })
            .collect();
        let represented: Vec<String> = result
            .sections
            .iter()
            .flat_map(|section| section.memory_ids.clone())
            .collect();
        Ok(json!({
            "query": query,
            "sections": sections,
            "representedIds": represented,
            "context": result.context,
            "diagnostics": {
                "retrievalMode": result.diagnostics.retrieval_mode,
                "cache": result.diagnostics.cache,
                "fallbackReason": result.diagnostics.fallback_reason,
                "vectorContribution": result.diagnostics.vector_contribution,
                "candidatePoolTruncated": result.diagnostics.candidate_pool_truncated,
                "omittedCount": result.diagnostics.omitted_count,
                "mandatoryTruncated": result.diagnostics.mandatory_truncated,
                "mandatoryOmitted": result.diagnostics.mandatory_omitted,
            },
        }))
    }

    /// Integrity and schema validation. `deep` runs a full integrity check;
    /// the default quick check keeps this inside the RPC budget.
    pub fn admin_validate(&self, deep: bool) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let check: String = connection.query_row(
            if deep {
                "PRAGMA integrity_check"
            } else {
                "PRAGMA quick_check"
            },
            [],
            |row| row.get(0),
        )?;
        let foreign_keys: i64 =
            connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })?;
        let schema_version: i64 = connection.query_row(
            "SELECT schema_version FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let fts_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM memory_fts", [], |row| row.get(0))
            .unwrap_or(-1);
        let active: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL",
            [],
            |row| row.get(0),
        )?;
        let expected = crate::config::STORE_SCHEMA_VERSION;
        Ok(json!({
            "ok": check == "ok" && foreign_keys == 0 && schema_version == expected && fts_rows >= 0,
            "integrity": check,
            "deep": deep,
            "foreignKeyViolations": foreign_keys,
            "schemaVersion": schema_version,
            "expectedSchemaVersion": expected,
            "ftsHealthy": fts_rows >= 0,
            "activeMemories": active,
        }))
    }

    /// Observe-only doctor report: health, coverage and categorical hints.
    pub fn admin_doctor(&self) -> CoreResult<Value> {
        let overview = self.view_overview(None)?;
        let health = self.view_health()?;
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let sources_total: i64 =
            connection.query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))?;
        let sources_unavailable: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sources WHERE state IN ('unavailable', 'ambiguous', 'failed')",
            [],
            |row| row.get(0),
        )?;
        let skipped_records: i64 = connection.query_row(
            "SELECT COALESCE(SUM(skipped_records), 0) FROM sources",
            [],
            |row| row.get(0),
        )?;
        let pending_extraction: i64 = connection.query_row(
            "SELECT COUNT(*) FROM extraction_intents WHERE state IN ('pending', 'retry_wait')",
            [],
            |row| row.get(0),
        )?;
        let mut hints = Vec::new();
        if sources_unavailable > 0 {
            hints.push(format!("{sources_unavailable} source(s) need attention"));
        }
        if skipped_records > 0 {
            hints.push(format!("{skipped_records} record(s) skipped with gaps"));
        }
        if pending_extraction > 0 {
            hints.push(format!("{pending_extraction} extraction intent(s) pending"));
        }
        if health["ready"] != true {
            hints.push("store schema is not current".to_string());
        }
        Ok(json!({
            "overview": overview,
            "health": health,
            "sources": {
                "total": sources_total,
                "unavailable": sources_unavailable,
                "skippedRecords": skipped_records,
            },
            "pendingExtraction": pending_extraction,
            "hints": hints,
        }))
    }

    /// Extraction coverage audit: per-source capture and extraction state with
    /// gaps accounted separately from completion.
    pub fn admin_audit_extractions(&self) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut statement = connection.prepare(
            "SELECT s.source_id, s.client, s.native_session_id, s.state, s.generation, \
             s.observed_size, s.offset, s.skipped_records, s.repository, s.repository_verified, \
             s.updated_ms, \
             (SELECT COUNT(*) FROM source_records r WHERE r.source_id = s.source_id \
              AND r.generation = s.generation) AS normalized, \
             i.state, i.rule_version, i.attempts, i.terminal_reason \
             FROM sources s LEFT JOIN extraction_intents i \
             ON i.source_id = s.source_id AND i.generation = s.generation \
             ORDER BY s.updated_ms DESC LIMIT 200",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(json!({
                "sourceId": row.get::<_, String>(0)?,
                "client": row.get::<_, String>(1)?,
                "nativeSessionId": row.get::<_, Option<String>>(2)?,
                "captureState": row.get::<_, String>(3)?,
                "generation": row.get::<_, String>(4)?,
                "observedSize": row.get::<_, i64>(5)?,
                "offset": row.get::<_, i64>(6)?,
                "skippedRecords": row.get::<_, i64>(7)?,
                "repository": row.get::<_, Option<String>>(8)?,
                "repositoryVerified": row.get::<_, i64>(9)? != 0,
                "updatedMs": row.get::<_, i64>(10)?,
                "normalizedRecords": row.get::<_, i64>(11)?,
                "extractionState": row.get::<_, Option<String>>(12)?,
                "ruleVersion": row.get::<_, Option<String>>(13)?,
                "attempts": row.get::<_, Option<i64>>(14)?,
                "terminalReason": row.get::<_, Option<String>>(15)?,
            }))
        })?;
        let sources: Vec<Value> = rows.collect::<Result<_, _>>()?;
        let with_gaps = sources
            .iter()
            .filter(|source| source["skippedRecords"].as_i64().unwrap_or(0) > 0)
            .count();
        Ok(json!({
            "sources": sources,
            "observedAt": now_ms(),
            "gaps": { "sourcesWithSkippedRecords": with_gaps },
        }))
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Unknown admin operation names never fall through to another handler.
pub fn known_admin(name: &str) -> bool {
    matches!(
        name,
        "search"
            | "explain"
            | "validate"
            | "doctor"
            | "audit/extractions"
            | "correct"
            | "purge"
            | "scope-override"
            | "scope-audit"
            | "run-status"
            | "onboard"
            | "deferred-process"
            | "backfill"
            | "maintenance"
            | "reflect"
    )
}

/// `None` query text is rejected for operations that need it.
pub fn require_query(query: Option<&str>) -> CoreResult<String> {
    match query.map(str::trim) {
        Some(value) if !value.is_empty() => Ok(value.to_string()),
        _ => Err(CoreError::invalid(
            "ADMIN_ARGUMENT_INVALID",
            "query is required",
        )),
    }
}
