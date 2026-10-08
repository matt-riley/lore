//! Deterministic episode digests and day summaries.
//!
//! Digests are derived, provider-free summaries of captured source
//! generations: turn counts, extracted propositions and a significance
//! bucket. They are not authoritative memory and never fabricate narrative.
//! Day summaries aggregate the episode digests for one repository and date.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::CoreResult;
use crate::store::Store;

const MAX_RECORDS: usize = 200;
const MAX_EXTRACTED: usize = 12;
const MAX_CONTENT_BYTES: usize = 4 * 1024;

/// Outcome of one digest pass.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestReport {
    pub episodes: usize,
    pub day_summaries: usize,
}

struct GenerationCandidate {
    source_id: String,
    generation: String,
    client: String,
    repository: Option<String>,
    native_session_id: Option<String>,
    started_ms: i64,
}

/// Civil date (year, month, day) for a Unix day number.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// UTC date key for an epoch-millisecond timestamp.
pub fn date_key(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn truncate_content(mut text: String) -> String {
    if text.len() > MAX_CONTENT_BYTES {
        let mut boundary = MAX_CONTENT_BYTES;
        while boundary > 0 && !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
        text.push_str("\n... (truncated)");
    }
    text
}

fn significance_of(user_turns: usize, extracted: usize) -> &'static str {
    if extracted >= 5 || user_turns >= 8 {
        "significant"
    } else if extracted >= 2 || user_turns >= 4 {
        "notable"
    } else {
        "routine"
    }
}

impl Store {
    /// Build episode digests for captured generations that lack one, then
    /// refresh the day summaries they feed. Idempotent: a second pass finds
    /// the episodes already present and only refreshes touched days.
    pub fn build_digests(&self, limit: usize, now_ms: i64) -> CoreResult<DigestReport> {
        let candidates: Vec<GenerationCandidate> = {
            let connection = self.reader();
            let connection = connection.lock().expect("reader lock");
            let mut statement = connection.prepare(
                "SELECT g.source_id, g.generation, s.client, s.repository, s.native_session_id, g.started_ms \
                 FROM source_generations g JOIN sources s ON s.source_id = g.source_id \
                 WHERE g.retired_ms IS NULL \
                 AND EXISTS (SELECT 1 FROM source_records r WHERE r.source_id = g.source_id AND r.generation = g.generation) \
                 AND NOT EXISTS (SELECT 1 FROM extraction_intents i \
                    WHERE i.source_id = g.source_id AND i.generation = g.generation \
                    AND i.state IN ('pending', 'running', 'retry_wait')) \
                 ORDER BY g.started_ms ASC LIMIT ?1",
            )?;
            let rows = statement.query_map(params![limit.clamp(1, 32) as i64], |row| {
                Ok(GenerationCandidate {
                    source_id: row.get(0)?,
                    generation: row.get(1)?,
                    client: row.get(2)?,
                    repository: row.get(3)?,
                    native_session_id: row.get(4)?,
                    started_ms: row.get(5)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        if candidates.is_empty() {
            return Ok(DigestReport::default());
        }

        let mut report = DigestReport::default();
        let mut touched_days: Vec<(Option<String>, String)> = Vec::new();
        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;

        for candidate in &candidates {
            let records =
                self.source_records(&candidate.source_id, &candidate.generation, MAX_RECORDS)?;
            if records.is_empty() {
                continue;
            }
            let user_turns = records
                .iter()
                .filter(|record| {
                    record.role.as_deref() == Some("user") || record.kind == "user_turn"
                })
                .count();
            let assistant_turns = records
                .iter()
                .filter(|record| {
                    record.role.as_deref() == Some("assistant") || record.kind == "assistant_turn"
                })
                .count();
            let tool_records = records
                .iter()
                .filter(|record| record.kind == "tool")
                .count();

            // Counts by kind only: a digest must never quote proposition
            // text, or a later forget would be resurrected through the
            // digest's own content.
            let extracted: Vec<(String, i64)> = {
                let mut statement = transaction.prepare(
                    "SELECT m.kind, COUNT(*) FROM memory_evidence e \
                     JOIN memories m ON m.id = e.memory_id \
                     WHERE e.source_id = ?1 AND e.generation = ?2 AND e.retired_ms IS NULL \
                     AND m.forgotten = 0 AND m.superseded_by IS NULL \
                     GROUP BY m.kind ORDER BY COUNT(*) DESC, m.kind ASC LIMIT ?3",
                )?;
                let rows = statement.query_map(
                    params![
                        candidate.source_id,
                        candidate.generation,
                        MAX_EXTRACTED as i64
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            let extracted_total: i64 = extracted.iter().map(|(_, count)| count).sum();

            let session = candidate
                .native_session_id
                .clone()
                .unwrap_or_else(|| candidate.source_id.clone());
            let day = date_key(candidate.started_ms);
            let significance = significance_of(user_turns, extracted_total as usize);
            let mut content = String::new();
            content.push_str(&format!(
                "# Episode {day} — {} {session}\n\n",
                candidate.client
            ));
            content.push_str(&format!(
                "Repository: {}\nTurns: {user_turns} user, {assistant_turns} assistant, {tool_records} tool\nSignificance: {significance}\n",
                candidate.repository.as_deref().unwrap_or("global")
            ));
            content.push_str(&format!("Extracted: {extracted_total} proposition(s)\n"));
            for (kind, count) in &extracted {
                content.push_str(&format!("- {count} x {kind}\n"));
            }
            let content = truncate_content(content);
            let content_hash = crate::policy::sha256_hex(content.as_bytes());
            let topic_key = format!("episode::{}::{}", candidate.source_id, candidate.generation);
            let (scope, repository) = match candidate.repository.as_deref() {
                Some(repository) => ("repo", Some(repository.to_string())),
                None => ("global", None),
            };
            let tags = json!([
                "episode_digest",
                candidate.client,
                format!("date:{day}"),
                format!("session:{session}"),
                format!("sig:{significance}"),
                format!("extracted:{extracted_total}")
            ]);
            let existing: Option<(String, String)> = transaction
                .query_row(
                    "SELECT id, content FROM memories WHERE kind = 'episode_digest' \
                     AND topic_key = ?1 AND forgotten = 0 AND superseded_by IS NULL LIMIT 1",
                    params![topic_key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok();
            if let Some((existing_id, existing_content)) = &existing {
                if existing_content == &content {
                    // Unchanged: nothing to refresh, not even the day summary.
                    continue;
                }
                revision += 1;
                transaction.execute(
                    "UPDATE memories SET content = ?2, content_hash = ?3, scope = ?4, repository = ?5, \
                     tags_json = ?6, revision = ?7, updated_ms = ?8 WHERE id = ?1",
                    params![
                        existing_id,
                        content,
                        content_hash,
                        scope,
                        repository,
                        tags.to_string(),
                        revision,
                        now_ms
                    ],
                )?;
                transaction.execute(
                    "UPDATE memory_fts SET content = ?1 WHERE memory_id = ?2",
                    params![content, existing_id],
                )?;
                super::ops::queue_embedding(
                    &transaction,
                    existing_id,
                    revision,
                    &content_hash,
                    self.embedding_enabled,
                    self.embedding_identity.as_deref(),
                    now_ms,
                )?;
                report.episodes += 1;
                let key = (candidate.repository.clone(), day);
                if !touched_days.contains(&key) {
                    touched_days.push(key);
                }
                continue;
            }
            revision += 1;
            let memory_id = uuid::Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO memories (id, kind, content, content_hash, scope, repository, authority, \
                 confidence, tags_json, source_session_id, created_ms, updated_ms, expires_at_ms, \
                 revision, forgotten, topic_key) \
                 VALUES (?1, 'episode_digest', ?2, ?3, ?4, ?5, 'inferred', 0.6, ?6, ?7, ?8, ?8, NULL, ?9, 0, ?10)",
                params![
                    memory_id,
                    content,
                    content_hash,
                    scope,
                    repository,
                    tags.to_string(),
                    candidate.native_session_id,
                    now_ms,
                    revision,
                    topic_key
                ],
            )?;
            transaction.execute(
                "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, 'episode_digest', 'episode', ?2)",
                params![content, memory_id],
            )?;
            super::ops::queue_embedding(
                &transaction,
                &memory_id,
                revision,
                &content_hash,
                self.embedding_enabled,
                self.embedding_identity.as_deref(),
                now_ms,
            )?;
            report.episodes += 1;
            let key = (candidate.repository.clone(), day);
            if !touched_days.contains(&key) {
                touched_days.push(key);
            }
        }

        for (repository, day) in &touched_days {
            let mut lines: Vec<String> = Vec::new();
            let mut episode_ids: Vec<String> = Vec::new();
            let mut day_extracted: i64 = 0;
            {
                let mut statement = transaction.prepare(
                    "SELECT id, content, tags_json FROM memories WHERE kind = 'episode_digest' \
                     AND forgotten = 0 AND superseded_by IS NULL \
                     AND COALESCE(repository, '') = COALESCE(?1, '') \
                     AND tags_json LIKE ?2 ORDER BY updated_ms ASC, id ASC LIMIT 50",
                )?;
                let pattern = format!("%\"date:{day}\"%");
                let rows = statement.query_map(params![repository, pattern], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?;
                for row in rows {
                    let (id, _content, tags_json) = row?;
                    let tags: serde_json::Value =
                        serde_json::from_str(&tags_json).unwrap_or(json!([]));
                    let session = tags
                        .as_array()
                        .and_then(|values| {
                            values.iter().find_map(|value| {
                                value
                                    .as_str()
                                    .and_then(|text| text.strip_prefix("session:"))
                                    .map(str::to_string)
                            })
                        })
                        .unwrap_or_else(|| id.clone());
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
                    let significance = tag("sig:");
                    let extracted = tag("extracted:").parse::<i64>().unwrap_or(0);
                    day_extracted += extracted;
                    lines.push(format!(
                        "- {session} ({significance}): {extracted} extracted"
                    ));
                    episode_ids.push(id);
                }
            }
            let mut content = format!("# Day summary {day}\n\n");
            content.push_str(&format!(
                "Repository: {}\nEpisodes: {}\n\n",
                repository.as_deref().unwrap_or("global"),
                lines.len()
            ));
            for line in &lines {
                content.push_str(line);
                content.push('\n');
            }
            let content = truncate_content(content);
            let content_hash = crate::policy::sha256_hex(content.as_bytes());
            let topic_key = format!(
                "day_summary::{}::{day}",
                repository.as_deref().unwrap_or("global")
            );
            let tags = json!([
                "day_summary",
                format!("date:{day}"),
                format!("episodes:{}", episode_ids.len()),
                format!("extracted:{day_extracted}")
            ]);
            let existing: Option<String> = transaction
                .query_row(
                    "SELECT id FROM memories WHERE kind = 'day_summary' AND topic_key = ?1 \
                     AND forgotten = 0 AND superseded_by IS NULL LIMIT 1",
                    params![topic_key],
                    |row| row.get(0),
                )
                .ok();
            match existing {
                Some(memory_id) => {
                    revision += 1;
                    transaction.execute(
                        "UPDATE memories SET content = ?2, content_hash = ?3, revision = ?4, \
                         updated_ms = ?5, tags_json = ?6 WHERE id = ?1",
                        params![
                            memory_id,
                            content,
                            content_hash,
                            revision,
                            now_ms,
                            tags.to_string()
                        ],
                    )?;
                    transaction.execute(
                        "UPDATE memory_fts SET content = ?1 WHERE memory_id = ?2",
                        params![content, memory_id],
                    )?;
                    super::ops::queue_embedding(
                        &transaction,
                        &memory_id,
                        revision,
                        &content_hash,
                        self.embedding_enabled,
                        self.embedding_identity.as_deref(),
                        now_ms,
                    )?;
                }
                None => {
                    revision += 1;
                    let memory_id = uuid::Uuid::new_v4().to_string();
                    let (scope, repository_value) = match repository {
                        Some(repository) => ("repo", Some(repository.clone())),
                        None => ("global", None),
                    };
                    transaction.execute(
                        "INSERT INTO memories (id, kind, content, content_hash, scope, repository, authority, \
                         confidence, tags_json, source_session_id, created_ms, updated_ms, expires_at_ms, \
                         revision, forgotten, topic_key) \
                         VALUES (?1, 'day_summary', ?2, ?3, ?4, ?5, 'inferred', 0.6, ?6, NULL, ?7, ?7, NULL, ?8, 0, ?9)",
                        params![
                            memory_id,
                            content,
                            content_hash,
                            scope,
                            repository_value,
                            tags.to_string(),
                            now_ms,
                            revision,
                            topic_key
                        ],
                    )?;
                    transaction.execute(
                        "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, 'day_summary', 'day summary', ?2)",
                        params![content, memory_id],
                    )?;
                    super::ops::queue_embedding(
                        &transaction,
                        &memory_id,
                        revision,
                        &content_hash,
                        self.embedding_enabled,
                        self.embedding_identity.as_deref(),
                        now_ms,
                    )?;
                }
            }
            report.day_summaries += 1;
        }

        if report.episodes > 0 || report.day_summaries > 0 {
            transaction.execute(
                "UPDATE store_metadata SET memory_revision = ?1, active_memories = \
                 (SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL) WHERE id = 1",
                params![revision],
            )?;
        }
        transaction.commit()?;
        Ok(report)
    }
}
