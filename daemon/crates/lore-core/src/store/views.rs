//! Read-only dashboard views. The browser gateway consumes these routes and
//! owns no SQL itself.

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::error::CoreResult;
use crate::store::Store;

/// Default page size and cap for keyset views.
pub const VIEW_PAGE_DEFAULT: u32 = 50;
pub const VIEW_PAGE_MAX: u32 = 200;

impl Store {
    /// Overview: store readiness, counts and source/extraction summaries.
    pub fn view_overview(&self, repository: Option<&str>) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let (store_id, schema_version, memory_revision, derived_generation): (
            String,
            i64,
            i64,
            i64,
        ) = connection.query_row(
            "SELECT store_id, schema_version, memory_revision, derived_generation \
                 FROM store_metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let active: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL",
            [],
            |row| row.get(0),
        )?;
        let forgotten: i64 = connection.query_row(
            "SELECT COUNT(*) FROM memories WHERE forgotten = 1",
            [],
            |row| row.get(0),
        )?;
        let repositories: Vec<String> = {
            let mut statement = connection.prepare(
                "SELECT DISTINCT repository FROM memories WHERE repository IS NOT NULL \
                 ORDER BY repository ASC LIMIT 200",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let kinds: Vec<(String, i64)> = {
            let mut statement = connection.prepare(
                "SELECT kind, COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL \
                 GROUP BY kind ORDER BY COUNT(*) DESC, kind ASC LIMIT 50",
            )?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let sources: i64 =
            connection.query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))?;
        let caught_up: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sources WHERE state = 'caught_up'",
            [],
            |row| row.get(0),
        )?;
        let pending_extraction: i64 = connection.query_row(
            "SELECT COUNT(*) FROM extraction_intents WHERE state IN ('pending', 'retry_wait')",
            [],
            |row| row.get(0),
        )?;
        let _ = repository;
        Ok(json!({
            "storeId": store_id,
            "schemaVersion": schema_version,
            "memoryRevision": memory_revision.to_string(),
            "derivedGeneration": derived_generation.to_string(),
            "activeMemories": active,
            "forgottenMemories": forgotten,
            "repositories": repositories,
            "kinds": kinds.into_iter().map(|(kind, count)| json!({"kind": kind, "count": count})).collect::<Vec<_>>(),
            "sources": { "total": sources, "caughtUp": caught_up },
            "pendingExtraction": pending_extraction,
        }))
    }

    /// Health summary: schema, FTS and migration state.
    pub fn view_health(&self) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let schema_version: i64 = connection.query_row(
            "SELECT schema_version FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let fts_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM memory_fts", [], |row| row.get(0))
            .unwrap_or(-1);
        let migration_state: Option<String> = connection
            .query_row(
                "SELECT state FROM migration_manifest ORDER BY started_ms DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(json!({
            "schemaVersion": schema_version,
            "ftsHealthy": fts_rows >= 0,
            "ftsRows": fts_rows,
            "migrationState": migration_state,
            "ready": schema_version == crate::config::STORE_SCHEMA_VERSION,
        }))
    }

    /// Keyset page of memories for the dashboard.
    #[allow(clippy::too_many_arguments)]
    pub fn view_memories(
        &self,
        repository: Option<&str>,
        kind: Option<&str>,
        scope: Option<&str>,
        query: Option<&str>,
        include_forgotten: bool,
        cursor: Option<&str>,
        page_size: u32,
    ) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let limit = page_size.clamp(1, VIEW_PAGE_MAX);
        let mut sql = String::from(
            "SELECT id, kind, content, scope, repository, authority, confidence, created_ms, \
             updated_ms, expires_at_ms, source_session_id, tags_json FROM memories WHERE 1 = 1",
        );
        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        if !include_forgotten {
            sql.push_str(" AND forgotten = 0 AND superseded_by IS NULL");
        }
        if let Some(repository) = repository {
            sql.push_str(" AND repository = ?");
            values.push(repository.to_string().into());
        }
        if let Some(kind) = kind {
            sql.push_str(" AND kind = ?");
            values.push(kind.to_string().into());
        }
        if let Some(scope) = scope {
            sql.push_str(" AND scope = ?");
            values.push(scope.to_string().into());
        }
        if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
            sql.push_str(" AND content LIKE ?");
            values.push(format!("%{}%", query.replace('%', "\\%")).into());
        }
        if let Some(cursor) = cursor {
            sql.push_str(" AND id > ?");
            values.push(cursor.to_string().into());
        }
        sql.push_str(" ORDER BY id ASC LIMIT ?");
        values.push(((limit + 1) as i64).into());
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(values.iter()), |row| {
            let tags_json: String = row.get(11)?;
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
                "content": row.get::<_, String>(2)?,
                "scope": row.get::<_, String>(3)?,
                "repository": row.get::<_, Option<String>>(4)?,
                "authority": row.get::<_, String>(5)?,
                "confidence": row.get::<_, f64>(6)?,
                "createdMs": row.get::<_, i64>(7)?,
                "updatedMs": row.get::<_, i64>(8)?,
                "expiresAtMs": row.get::<_, Option<i64>>(9)?,
                "sourceSessionId": row.get::<_, Option<String>>(10)?,
                "tags": serde_json::from_str::<Value>(&tags_json).unwrap_or(json!([])),
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
            "pageSize": limit,
        }))
    }

    /// Distinct filters used by the dashboard.
    pub fn view_filters(&self) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let kinds: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT kind, COUNT(*) FROM memories GROUP BY kind ORDER BY COUNT(*) DESC, kind ASC",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(json!({ "kind": row.get::<_, String>(0)?, "count": row.get::<_, i64>(1)? }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let scopes: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT scope, COUNT(*) FROM memories GROUP BY scope ORDER BY scope ASC",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(json!({ "scope": row.get::<_, String>(0)?, "count": row.get::<_, i64>(1)? }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let repositories: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT repository, COUNT(*) FROM memories WHERE repository IS NOT NULL \
                 GROUP BY repository ORDER BY COUNT(*) DESC, repository ASC LIMIT 200",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(json!({ "repository": row.get::<_, String>(0)?, "count": row.get::<_, i64>(1)? }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        Ok(json!({ "kinds": kinds, "scopes": scopes, "repositories": repositories }))
    }

    /// Maintenance summary: queues and background work.
    pub fn view_maintenance(&self) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let jobs: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT state, COUNT(*) FROM embedding_jobs GROUP BY state ORDER BY state ASC",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(json!({ "state": row.get::<_, String>(0)?, "count": row.get::<_, i64>(1)? }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let extraction: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT state, COUNT(*) FROM extraction_intents GROUP BY state ORDER BY state ASC",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(json!({ "state": row.get::<_, String>(0)?, "count": row.get::<_, i64>(1)? }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let source_states: Vec<Value> = {
            let mut statement =
                connection.prepare("SELECT state, COUNT(*) FROM sources GROUP BY state")?;
            let rows = statement.query_map([], |row| {
                Ok(json!({ "state": row.get::<_, String>(0)?, "count": row.get::<_, i64>(1)? }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        Ok(json!({
            "embeddingJobs": jobs,
            "extraction": extraction,
            "sources": source_states,
        }))
    }

    /// Episodes view: deterministic episode digests and the day summaries
    /// they feed, plus the extraction runs that produced the evidence.
    pub fn view_episodes(&self) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let episodes: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT id, content, scope, repository, tags_json, updated_ms FROM memories                  WHERE kind = 'episode_digest' AND forgotten = 0 AND superseded_by IS NULL                  ORDER BY updated_ms DESC, id ASC LIMIT 100",
            )?;
            let rows = statement.query_map([], |row| {
                let tags_json: String = row.get(4)?;
                let tags: Value = serde_json::from_str(&tags_json).unwrap_or(json!([]));
                let tag = |prefix: &str| {
                    tags.as_array()
                        .and_then(|values| {
                            values.iter().find_map(|value| {
                                value
                                    .as_str()
                                    .and_then(|text| text.strip_prefix(prefix))
                                    .map(str::to_string)
                            })
                        })
                        .unwrap_or_default()
                };
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "summary": row.get::<_, String>(1)?,
                    "scope": row.get::<_, String>(2)?,
                    "scopeSource": "inferred",
                    "repository": row.get::<_, Option<String>>(3)?,
                    "branch": null,
                    "sessionId": tag("session:"),
                    "dateKey": tag("date:"),
                    "significance": tag("sig:"),
                    "source": "lore_digest",
                    "actions": [],
                    "decisions": [],
                    "learnings": [],
                    "filesChanged": [],
                    "refs": [],
                    "themes": [],
                    "openItems": [],
                    "updatedAt": row.get::<_, i64>(5)?,
                }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let day_summaries: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT content, repository, tags_json, updated_ms FROM memories                  WHERE kind = 'day_summary' AND forgotten = 0 AND superseded_by IS NULL                  ORDER BY updated_ms DESC, id ASC LIMIT 60",
            )?;
            let rows = statement.query_map([], |row| {
                let tags_json: String = row.get(2)?;
                let tags: Value = serde_json::from_str(&tags_json).unwrap_or(json!([]));
                let date_key = tags
                    .as_array()
                    .and_then(|values| {
                        values.iter().find_map(|value| {
                            value
                                .as_str()
                                .and_then(|text| text.strip_prefix("date:"))
                                .map(str::to_string)
                        })
                    })
                    .unwrap_or_default();
                Ok(json!({
                    "dateKey": date_key,
                    "repository": row.get::<_, Option<String>>(1)?,
                    "summary": row.get::<_, String>(0)?,
                    "episodeIds": [],
                    "computedAt": row.get::<_, i64>(3)?,
                    "updatedAt": row.get::<_, i64>(3)?,
                }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let runs: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT source_id, generation, state, updated_ms FROM extraction_intents \
                 ORDER BY updated_ms DESC LIMIT 100",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(json!({
                    "sourceId": row.get::<_, String>(0)?,
                    "generation": row.get::<_, String>(1)?,
                    "state": row.get::<_, String>(2)?,
                    "updatedMs": row.get::<_, i64>(3)?,
                }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        Ok(json!({
            "episodes": episodes,
            "daySummaries": day_summaries,
            "extractionRuns": runs,
            "note": "episode digests are deterministic summaries of captured sources",
        }))
    }

    /// Drill-down by memory id: record, evidence links and suppression state.
    pub fn view_drilldown(&self, id: &str) -> CoreResult<Value> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let memory: Option<Value> = connection
            .query_row(
                "SELECT id, kind, content, scope, repository, authority, confidence, created_ms, \
                 updated_ms, forgotten, superseded_by FROM memories WHERE id = ?1",
                params![id],
                |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "kind": row.get::<_, String>(1)?,
                        "content": row.get::<_, String>(2)?,
                        "scope": row.get::<_, String>(3)?,
                        "repository": row.get::<_, Option<String>>(4)?,
                        "authority": row.get::<_, String>(5)?,
                        "confidence": row.get::<_, f64>(6)?,
                        "createdMs": row.get::<_, i64>(7)?,
                        "updatedMs": row.get::<_, i64>(8)?,
                        "forgotten": row.get::<_, i64>(9)? != 0,
                        "supersededBy": row.get::<_, Option<String>>(10)?,
                    }))
                },
            )
            .optional()?;
        let Some(memory) = memory else {
            return Ok(json!({ "found": false }));
        };
        let evidence: Vec<Value> = {
            let mut statement = connection.prepare(
                "SELECT source_id, generation, evidence_key, role, created_ms, retired_ms \
                 FROM memory_evidence WHERE memory_id = ?1 ORDER BY evidence_key ASC LIMIT 200",
            )?;
            let rows = statement.query_map(params![id], |row| {
                Ok(json!({
                    "sourceId": row.get::<_, String>(0)?,
                    "generation": row.get::<_, String>(1)?,
                    "evidenceKey": row.get::<_, String>(2)?,
                    "role": row.get::<_, Option<String>>(3)?,
                    "createdMs": row.get::<_, i64>(4)?,
                    "retiredMs": row.get::<_, Option<i64>>(5)?,
                }))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let suppressed: i64 = connection.query_row(
            "SELECT COUNT(*) FROM suppressions WHERE memory_id = ?1 AND state = 'active'",
            params![id],
            |row| row.get(0),
        )?;
        Ok(json!({
            "found": true,
            "memory": memory,
            "evidence": evidence,
            "suppressed": suppressed > 0,
        }))
    }
}

/// Parse the dashboard view name and return `None` for unknown views.
pub fn known_view(name: &str) -> bool {
    matches!(
        name,
        "overview"
            | "health"
            | "memories"
            | "memories/filters"
            | "maintenance"
            | "episodes"
            | "drilldown"
    )
}
