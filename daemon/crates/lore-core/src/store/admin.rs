//! Read-only administration operations: lexical search, explanation,
//! validation, doctor, extraction audit and capability inventory.
//!
//! These are bounded synchronous reads. They never persist query text and
//! never mutate store state.

use rusqlite::params;
use rusqlite::{OptionalExtension, params_from_iter};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

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
    /// Doctor report: bounded, observe-only diagnostics with an install-health
    /// section, a bounded trajectory listing and planned-but-unexecuted
    /// actions. `dry_run` is accepted for interface parity and is always the
    /// effective behavior: doctor never mutates.
    pub fn admin_doctor(&self, dry_run: bool, trajectory_limit: u32) -> CoreResult<Value> {
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

        // Install health: what the operator's machine looks like, observed
        // only. The v2 daemon needs no Node; hosts and v1 integrations do.
        let data_dir = self
            .store_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let node = std::process::Command::new("node")
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
        let legacy_cli = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .and_then(|directory| directory.parent().map(Path::to_path_buf))
            .map(|root| root.join("lore-cli.mjs"))
            .filter(|path| path.is_file());
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let legacy_cli_home = home
            .as_ref()
            .map(|home| home.join(".lore/lore-cli.mjs"))
            .filter(|path| path.is_file());
        let unit_installed = home
            .as_ref()
            .map(|home| home.join(".lore/service.json"))
            .is_some_and(|path| path.is_file());

        let mut duplicates: Vec<String> = Vec::new();
        for binary in ["lore", "lored"] {
            let mut found: Vec<PathBuf> = Vec::new();
            for directory in std::env::var_os("PATH")
                .into_iter()
                .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
            {
                let candidate = directory.join(binary);
                if candidate.is_file() && !found.contains(&candidate) {
                    found.push(candidate);
                }
            }
            if found.len() > 1 {
                duplicates.extend(found.into_iter().map(|path| path.display().to_string()));
            }
        }
        let legacy_paths: Vec<String> = [
            legacy_cli.as_ref().map(|path| path.display().to_string()),
            legacy_cli_home
                .as_ref()
                .map(|path| path.display().to_string()),
        ]
        .into_iter()
        .flatten()
        .collect();
        let install_health = json!({
            "node": {
                "found": node.is_some(),
                "version": node,
                "required": false,
                "note": "the v2 daemon and CLI need no Node; host adapters and v1 integrations do",
            },
            "legacyCli": {
                "found": legacy_cli.is_some() || legacy_cli_home.is_some(),
                "paths": legacy_paths,
                "note": "lore-cli.mjs is a v1 artifact; its absence is expected for a v2-only install",
            },
            "serviceInstalled": unit_installed,
            "duplicateInstalls": duplicates,
        });
        if !duplicates.is_empty() {
            hints.push("duplicate lore binaries found on PATH".to_string());
        }

        // Trajectory artifacts: a bounded, read-only listing when present.
        let trajectory_dir = data_dir.join("trajectory");
        let mut trajectory_artifacts: Vec<Value> = Vec::new();
        if trajectory_dir.is_dir()
            && let Ok(entries) = std::fs::read_dir(&trajectory_dir)
        {
            for entry in entries
                .flatten()
                .take(trajectory_limit.clamp(1, 200) as usize)
            {
                let path = entry.path();
                if let Ok(metadata) = entry.metadata() {
                    trajectory_artifacts.push(json!({
                        "name": entry.file_name().to_string_lossy().to_string(),
                        "path": path.display().to_string(),
                        "bytes": metadata.len(),
                        "kind": "trajectory-artifact",
                    }));
                }
            }
        }

        let source_cases: Vec<String> = {
            let mut statement = connection.prepare(
                "SELECT source_id FROM sources WHERE skipped_records > 0 \
                 OR state IN ('unavailable', 'ambiguous', 'failed') ORDER BY updated_ms DESC LIMIT 50",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut planned_actions = Vec::new();
        if pending_extraction > 0 {
            planned_actions.push(json!({
                "action": "deferred-process",
                "would": "claim pending extraction intents and apply their proposals",
                "executed": false,
            }));
        }
        if sources_unavailable > 0 {
            planned_actions.push(json!({
                "action": "repair",
                "would": "rebuild missing FTS rows and requeue stale embedding intents",
                "executed": false,
            }));
        }
        if skipped_records > 0 {
            planned_actions.push(json!({
                "action": "sources-status",
                "would": "inspect sources with record gaps before any re-capture",
                "executed": false,
            }));
        }
        let mut health_reasons = Vec::new();
        for hint in &hints {
            health_reasons.push(json!({ "category": "store", "reason": hint }));
        }
        if health["ready"] != true {
            health_reasons.push(
                json!({ "category": "schema", "reason": "store schema is behind the binary" }),
            );
        }

        Ok(json!({
            "dryRun": true,
            "dryRunRequested": dry_run,
            "overview": overview,
            "health": health,
            "sources": {
                "total": sources_total,
                "unavailable": sources_unavailable,
                "skippedRecords": skipped_records,
            },
            "pendingExtraction": pending_extraction,
            "hints": hints,
            "installHealth": install_health,
            "trajectoryArtifacts": trajectory_artifacts,
            "plannedActions": planned_actions,
            "sourceCases": source_cases,
            "healthReasons": health_reasons,
        }))
    }

    /// Extraction coverage audit: per-source capture and extraction state with
    /// gaps accounted separately from completion.
    /// Revalidation marker name for one extraction run.
    pub fn revalidation_marker(run_id: &str) -> String {
        format!("extractor-revalidation:{run_id}")
    }

    /// Apply or roll back one revalidation marker. Report-only by default:
    /// markers record that a run's extraction was revalidated by a human and
    /// never create suppression rows.
    pub fn admin_revalidate_extraction(
        &self,
        run_id: &str,
        apply: bool,
        now_ms: i64,
    ) -> CoreResult<Value> {
        let run_id = run_id.trim();
        if run_id.is_empty() {
            return Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                "revalidation needs a runId",
            ));
        }
        let marker = Self::revalidation_marker(run_id);
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT source_id, generation, rule_version FROM extraction_revalidation \
                 WHERE run_id = ?1 AND rolled_back_ms IS NULL",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let value = if apply {
            if let Some((source_id, generation, rule_version)) = existing {
                json!({
                    "runId": run_id,
                    "marker": marker,
                    "state": "already-applied",
                    "sourceId": source_id,
                    "generation": generation,
                    "ruleVersion": rule_version,
                })
            } else {
                // The marker must name a real, completed extraction run.
                let run: Option<(String, String, String)> = transaction
                    .query_row(
                        "SELECT s.source_id, s.generation, COALESCE(i.rule_version, '') \
                         FROM sources s JOIN extraction_intents i \
                         ON i.source_id = s.source_id AND i.generation = s.generation \
                         WHERE s.source_id = ?1",
                        params![run_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                let Some((source_id, generation, rule_version)) = run else {
                    return Err(CoreError::not_found(
                        "REVALIDATION_TARGET_NOT_FOUND",
                        "no completed extraction run matches that run id",
                    ));
                };
                transaction.execute(
                    "INSERT INTO extraction_revalidation (run_id, marker, source_id, generation, rule_version, applied_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                     ON CONFLICT (run_id) DO UPDATE SET marker = excluded.marker, \
                      source_id = excluded.source_id, generation = excluded.generation, \
                      rule_version = excluded.rule_version, applied_ms = excluded.applied_ms, \
                      rolled_back_ms = NULL",
                    params![run_id, marker, source_id, generation, rule_version, now_ms],
                )?;
                json!({
                    "runId": run_id,
                    "marker": marker,
                    "state": "applied",
                    "sourceId": source_id,
                    "generation": generation,
                    "ruleVersion": rule_version,
                })
            }
        } else {
            let Some((source_id, generation, rule_version)) = existing else {
                return Err(CoreError::not_found(
                    "REVALIDATION_MARKER_NOT_FOUND",
                    "no active marker for that run id",
                ));
            };
            transaction.execute(
                "UPDATE extraction_revalidation SET rolled_back_ms = ?1 WHERE run_id = ?2",
                params![now_ms, run_id],
            )?;
            json!({
                "runId": run_id,
                "marker": marker,
                "state": "rolled-back",
                "sourceId": source_id,
                "generation": generation,
                "ruleVersion": rule_version,
            })
        };
        transaction.commit()?;
        Ok(value)
    }

    /// Refetch client-selected records for analysis. Only the id and
    /// revision are trusted; content comes from the store and must be active,
    /// unexpired and visible to the requested repository.
    pub fn analysis_records(
        &self,
        repository: Option<&str>,
        selection: &[(String, i64)],
        now_ms: i64,
    ) -> CoreResult<Vec<Value>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let mut out = Vec::new();
        for (id, revision) in selection.iter().take(50) {
            let row: Option<(String, i64, String, String, Option<String>)> = connection
                .query_row(
                    "SELECT id, revision, content, scope, repository FROM memories \
                     WHERE id = ?1 AND forgotten = 0 AND superseded_by IS NULL \
                     AND (expires_at_ms IS NULL OR expires_at_ms > ?2)",
                    params![id, now_ms],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()?;
            let Some((id, actual_revision, content, scope, row_repository)) = row else {
                continue;
            };
            if actual_revision != *revision {
                continue;
            }
            let visible = match scope.as_str() {
                "global" => true,
                _ => match (repository, row_repository.as_deref()) {
                    (Some(wanted), Some(actual)) => wanted == actual,
                    (None, _) => false,
                    _ => false,
                },
            };
            if !visible {
                continue;
            }
            out.push(json!({
                "id": id,
                "revision": actual_revision,
                "content": content,
                "scope": scope,
                "repository": row_repository,
            }));
        }
        Ok(out)
    }

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
        let mut sources: Vec<Value> = rows.collect::<Result<_, _>>()?;
        let with_gaps = sources
            .iter()
            .filter(|source| source["skippedRecords"].as_i64().unwrap_or(0) > 0)
            .count();
        let revalidations: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT run_id, marker, source_id, generation, rule_version, applied_ms, rolled_back_ms \
                 FROM extraction_revalidation ORDER BY applied_ms DESC LIMIT 50",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(json!({
                    "runId": row.get::<_, String>(0)?,
                    "marker": row.get::<_, String>(1)?,
                    "sourceId": row.get::<_, String>(2)?,
                    "generation": row.get::<_, String>(3)?,
                    "ruleVersion": row.get::<_, String>(4)?,
                    "appliedMs": row.get::<_, i64>(5)?,
                    "rolledBackMs": row.get::<_, Option<i64>>(6)?,
                }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let revalidated: std::collections::HashSet<String> = revalidations
            .iter()
            .filter(|entry| entry["rolledBackMs"].is_null())
            .filter_map(|entry| entry["runId"].as_str().map(str::to_string))
            .collect();
        for source in &mut sources {
            if let Some(id) = source["sourceId"].as_str().map(str::to_string) {
                source["revalidated"] = json!(revalidated.contains(&id));
            }
        }
        Ok(json!({
            "sources": sources,
            "revalidations": revalidations,
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
            | "backlog"
            | "ledger"
            | "journal"
            | "review-gate"
            | "bundle"
            | "skill-validate"
            | "repair"
            | "replay"
            | "migration-unscoped"
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
