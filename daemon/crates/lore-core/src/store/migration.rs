//! Staged v1 import inside the v2 store: bounded chunks, cursors and
//! per-table accounting. The source snapshot is opened read-only.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{CoreError, CoreResult};
use crate::migration::{MigrateCounts, map_id, parse_iso_ms};
use crate::store::Store;

const CHUNK: i64 = 512;

fn table_exists(connection: &Connection, name: &str) -> CoreResult<bool> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn columns(connection: &Connection, table: &str) -> CoreResult<Vec<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn value_str(row: &BTreeMap<String, Value>, column: &str) -> Option<String> {
    match row.get(column) {
        Some(Value::Text(text)) => Some(text.clone()),
        Some(Value::Integer(number)) => Some(number.to_string()),
        Some(Value::Real(number)) => Some(number.to_string()),
        _ => None,
    }
}

/// Read one chunk of rows after a rowid cursor.
fn read_chunk(
    source: &Connection,
    table: &str,
    cursor: i64,
) -> CoreResult<Vec<(i64, BTreeMap<String, Value>)>> {
    let names = columns(source, table)?;
    let mut statement = source.prepare(&format!(
        "SELECT rowid, * FROM {table} WHERE rowid > ?1 ORDER BY rowid ASC LIMIT ?2"
    ))?;
    let mut rows = statement.query(params![cursor, CHUNK])?;
    let mut chunk = Vec::new();
    while let Some(row) = rows.next()? {
        let rowid: i64 = row.get(0)?;
        let mut values = BTreeMap::new();
        for (index, name) in names.iter().enumerate() {
            values.insert(name.clone(), row.get::<_, Value>(index + 1)?);
        }
        chunk.push((rowid, values));
    }
    Ok(chunk)
}

impl Store {
    /// Write the initial migration manifest row.
    pub fn begin_migration(
        &self,
        run_id: &str,
        schema_version: i64,
        fingerprint: &str,
        source_path: &str,
        now_ms: i64,
    ) -> CoreResult<()> {
        let counts = MigrateCounts::default();
        let connection = self.writer.lock().expect("writer lock");
        connection.execute(
            "INSERT INTO migration_manifest (run_id, state, schema_version, source_fingerprint, \
             source_path, started_ms, finished_ms, counts_json, cursor_json, detail_json) \
             VALUES (?1, 'incomplete', ?2, ?3, ?4, ?5, NULL, ?6, '{}', '{}')",
            params![
                run_id,
                schema_version,
                fingerprint,
                source_path,
                now_ms,
                serde_json::to_string(&counts)?
            ],
        )?;
        Ok(())
    }

    /// Migration state of this store, when it is a staging or imported store.
    pub fn migration_state(&self) -> CoreResult<Option<String>> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        if !table_exists(&connection, "migration_manifest")? {
            return Ok(None);
        }
        Ok(connection
            .query_row(
                "SELECT state FROM migration_manifest ORDER BY started_ms DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn migration_counts(&self) -> CoreResult<MigrateCounts> {
        let connection = self.reader();
        let connection = connection.lock().expect("reader lock");
        let raw: Option<String> = connection
            .query_row(
                "SELECT counts_json FROM migration_manifest ORDER BY started_ms DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(raw
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default())
    }

    fn migration_cursor(&self) -> CoreResult<BTreeMap<String, i64>> {
        let connection = self.writer.lock().expect("writer lock");
        let raw: Option<String> = connection
            .query_row(
                "SELECT cursor_json FROM migration_manifest ORDER BY started_ms DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(raw
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default())
    }

    /// Import the authoritative v1 tables from an immutable snapshot. Safe to
    /// call repeatedly: cursors and deterministic IDs make it idempotent.
    pub fn migration_import(
        &self,
        snapshot: &Path,
        run_id: &str,
        _schema_version: i64,
        now_ms: i64,
    ) -> CoreResult<()> {
        let source =
            Connection::open_with_flags(snapshot, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|error| {
                    CoreError::precondition("MIGRATE_SOURCE_UNREADABLE", format!("{error}"))
                })?;
        let mut cursor = self.migration_cursor()?;
        let mut counts = self.migration_counts()?;

        // Suppression and retirement first: they must exist before any
        // imported content can become eligible.
        if table_exists(&source, "memory_suppression")? {
            import_suppressions(self, &source, run_id, &mut cursor, &mut counts, now_ms)?;
        }
        // Semantic rows, then evidence links and repository mappings.
        import_semantic_memory(self, &source, run_id, &mut cursor, &mut counts, now_ms)?;
        if table_exists(&source, "memory_evidence")? && table_exists(&source, "session_evidence")? {
            import_evidence(self, &source, run_id, &mut cursor, &mut counts, now_ms)?;
        }
        if table_exists(&source, "repository_identity_mapping")? {
            import_repository_mappings(self, &source, run_id, &mut cursor, &mut counts, now_ms)?;
        }
        // Imported suppression is authoritative: matching rows become
        // forgotten and leave the search index before anything can serve them.
        {
            let connection = self.writer.lock().expect("writer lock");
            connection.execute(
                "DELETE FROM memory_fts WHERE memory_id IN ( \
                   SELECT memory_id FROM suppressions WHERE state = 'active')",
                [],
            )?;
            connection.execute(
                "UPDATE memories SET forgotten = 1, content = '', revision = revision + 1 \
                 WHERE id IN (SELECT memory_id FROM suppressions WHERE state = 'active')",
                [],
            )?;
        }
        remap_supersessions(self, run_id)?;
        rebuild_metadata(self, now_ms)?;
        self.write_migration_state(&cursor, &counts, "importing", now_ms)?;
        Ok(())
    }

    fn write_migration_state(
        &self,
        cursor: &BTreeMap<String, i64>,
        counts: &MigrateCounts,
        state: &str,
        now_ms: i64,
    ) -> CoreResult<()> {
        let connection = self.writer.lock().expect("writer lock");
        connection.execute(
            "UPDATE migration_manifest SET state = ?2, counts_json = ?3, cursor_json = ?4 \
             WHERE run_id = (SELECT run_id FROM migration_manifest ORDER BY started_ms DESC LIMIT 1)",
            params![
                now_ms,
                state,
                serde_json::to_string(counts)?,
                serde_json::to_string(cursor)?
            ],
        )?;
        Ok(())
    }
}

fn bump(counts: &mut MigrateCounts, table: &str) {
    *counts.imported.entry(table.to_string()).or_insert(0) += 1;
}

fn resolve(counts: &mut MigrateCounts, table: &str, reason: &str) {
    let key = format!("{table}:{reason}");
    *counts.unresolved.entry(key).or_insert(0) += 1;
}

fn import_suppressions(
    store: &Store,
    source: &Connection,
    run_id: &str,
    cursor: &mut BTreeMap<String, i64>,
    counts: &mut MigrateCounts,
    now_ms: i64,
) -> CoreResult<()> {
    let mut position = *cursor.get("memory_suppression").unwrap_or(&0);
    loop {
        let chunk = read_chunk(source, "memory_suppression", position)?;
        if chunk.is_empty() {
            break;
        }
        let mut connection = store.writer.lock().expect("writer lock");
        let transaction = connection.transaction()?;
        for (rowid, row) in &chunk {
            position = *rowid;
            let state = value_str(row, "superseded_at")
                .filter(|value| !value.is_empty())
                .map(|_| "retired")
                .unwrap_or("active");
            if state == "retired" {
                *counts
                    .excluded
                    .entry("memory_suppression".to_string())
                    .or_insert(0) += 1;
                continue;
            }
            let Some(memory_id) =
                value_str(row, "memory_id").or_else(|| value_str(row, "suppression_key"))
            else {
                resolve(counts, "memory_suppression", "missing_identity");
                continue;
            };
            let (mapped, remapped) = map_id(&memory_id);
            if remapped {
                counts.remapped_ids += 1;
            }
            let scope = value_str(row, "scope").unwrap_or_else(|| "repo".to_string());
            let repository = value_str(row, "repository");
            if scope != "global" && repository.is_none() {
                resolve(counts, "memory_suppression", "unresolved_scope");
                continue;
            }
            let fingerprint = value_str(row, "canonical_fingerprint")
                .or_else(|| value_str(row, "evidence_fingerprint"))
                .unwrap_or_default();
            let reason = value_str(row, "reason").unwrap_or_else(|| "migrated_v1".to_string());
            let created = value_str(row, "created_at")
                .and_then(|value| parse_iso_ms(&value))
                .unwrap_or(now_ms);
            transaction.execute(
                "INSERT INTO suppressions (memory_id, scope, repository, fingerprint, reason, revision, created_ms, state) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 'active') \
                 ON CONFLICT DO NOTHING",
                params![mapped, scope, repository, fingerprint, reason, created],
            )?;
            bump(counts, "memory_suppression");
        }
        transaction.execute(
            "UPDATE migration_manifest SET cursor_json = ?2, counts_json = ?3 WHERE run_id = ?1",
            params![
                run_id,
                serde_json::to_string(cursor)?,
                serde_json::to_string(counts)?
            ],
        )?;
        transaction.commit()?;
        cursor.insert("memory_suppression".to_string(), position);
    }
    Ok(())
}

fn import_semantic_memory(
    store: &Store,
    source: &Connection,
    run_id: &str,
    cursor: &mut BTreeMap<String, i64>,
    counts: &mut MigrateCounts,
    now_ms: i64,
) -> CoreResult<()> {
    let mut position = *cursor.get("semantic_memory").unwrap_or(&0);
    loop {
        let chunk = read_chunk(source, "semantic_memory", position)?;
        if chunk.is_empty() {
            break;
        }
        let mut connection = store.writer.lock().expect("writer lock");
        let transaction = connection.transaction()?;
        for (rowid, row) in &chunk {
            position = *rowid;
            let Some(v1_id) = value_str(row, "id") else {
                resolve(counts, "semantic_memory", "missing_id");
                continue;
            };
            let (memory_id, remapped) = map_id(&v1_id);
            let Some(content) = value_str(row, "content").filter(|value| !value.trim().is_empty())
            else {
                resolve(counts, "semantic_memory", "empty_content");
                continue;
            };
            let scope = value_str(row, "scope").unwrap_or_else(|| "repo".to_string());
            if !matches!(scope.as_str(), "global" | "repo" | "transferable") {
                resolve(counts, "semantic_memory", "unknown_scope");
                continue;
            }
            let repository = value_str(row, "repository").filter(|value| !value.is_empty());
            // The store checks this invariant: a non-global scope must name a
            // repository, so an unscoped row is quarantined rather than
            // rewritten here. The explicit unscoped import decides otherwise.
            if scope != "global" && repository.is_none() {
                resolve(counts, "semantic_memory", "unresolved_repository");
                continue;
            }
            let Some(created) = value_str(row, "created_at").and_then(|value| parse_iso_ms(&value))
            else {
                resolve(counts, "semantic_memory", "invalid_created_at");
                continue;
            };
            let updated = value_str(row, "updated_at")
                .and_then(|value| parse_iso_ms(&value))
                .unwrap_or(created);
            let expires = value_str(row, "expires_at").and_then(|value| parse_iso_ms(&value));
            if value_str(row, "expires_at")
                .is_some_and(|value| !value.is_empty() && expires.is_none())
            {
                resolve(counts, "semantic_memory", "invalid_expires_at");
                continue;
            }
            let kind = value_str(row, "type").unwrap_or_else(|| "note".to_string());
            let confidence = match row.get("confidence") {
                Some(Value::Real(number)) => *number,
                Some(Value::Integer(number)) => *number as f64,
                _ => 1.0,
            };
            let tags = value_str(row, "tags").unwrap_or_default();
            let tags: Vec<String> = tags
                .split([',', ';'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect();
            let metadata = value_str(row, "metadata_json").unwrap_or_default();
            let authority = if metadata.contains("\"source\":\"manual\"")
                || metadata.contains("\"authority\":\"manual\"")
                || metadata.contains("\"source\": \"manual\"")
            {
                "manual"
            } else {
                "auto"
            };
            let topic_key = value_str(row, "canonical_key")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| crate::store::content_hash(&content));
            if remapped {
                counts.remapped_ids += 1;
            }
            let inserted = transaction.execute(
                "INSERT INTO memories (id, kind, content, content_hash, scope, repository, authority, \
                 confidence, tags_json, source_session_id, created_ms, updated_ms, expires_at_ms, \
                 revision, forgotten, topic_key, superseded_by) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, 0, ?14, NULL) \
                 ON CONFLICT (id) DO NOTHING",
                params![
                    memory_id,
                    kind,
                    content,
                    crate::store::content_hash(&content),
                    scope,
                    repository,
                    authority,
                    confidence,
                    serde_json::to_string(&tags)?,
                    value_str(row, "source_session_id"),
                    created,
                    updated,
                    expires,
                    topic_key,
                ],
            )?;
            if inserted > 0 {
                transaction.execute(
                    "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, ?2, ?3, ?4)",
                    params![content, kind, tags.join(" "), memory_id],
                )?;
                transaction.execute(
                    "INSERT OR IGNORE INTO embedding_intents \
                     (memory_id, desired_revision, state, attempts, next_attempt_ms, terminal_reason, \
                      content_hash, model_identity, updated_ms) \
                     VALUES (?1, 1, 'pending', 0, NULL, NULL, ?2, '', ?3)",
                    params![memory_id, crate::store::content_hash(&content), now_ms],
                )?;
            }
            transaction.execute(
                "INSERT INTO migration_id_map (v1_id, v2_id) VALUES (?1, ?2) \
                 ON CONFLICT (v1_id) DO NOTHING",
                params![v1_id, memory_id],
            )?;
            if let Some(superseded_by) =
                value_str(row, "superseded_by").filter(|value| !value.is_empty())
            {
                transaction.execute(
                    "INSERT INTO migration_supersession (v1_id, superseded_by_v1) VALUES (?1, ?2) \
                     ON CONFLICT (v1_id) DO UPDATE SET superseded_by_v1 = excluded.superseded_by_v1",
                    params![v1_id, superseded_by],
                )?;
            }
            bump(counts, "semantic_memory");
        }
        transaction.execute(
            "UPDATE migration_manifest SET cursor_json = ?2, counts_json = ?3 WHERE run_id = ?1",
            params![
                run_id,
                serde_json::to_string(cursor)?,
                serde_json::to_string(counts)?
            ],
        )?;
        transaction.commit()?;
        cursor.insert("semantic_memory".to_string(), position);
    }
    Ok(())
}

fn import_evidence(
    store: &Store,
    source: &Connection,
    run_id: &str,
    cursor: &mut BTreeMap<String, i64>,
    counts: &mut MigrateCounts,
    now_ms: i64,
) -> CoreResult<()> {
    let mut position = *cursor.get("memory_evidence").unwrap_or(&0);
    loop {
        let chunk = read_chunk(source, "memory_evidence", position)?;
        if chunk.is_empty() {
            break;
        }
        let mut connection = store.writer.lock().expect("writer lock");
        let transaction = connection.transaction()?;
        for (rowid, row) in &chunk {
            position = *rowid;
            let Some(v1_memory_id) = value_str(row, "memory_id") else {
                resolve(counts, "memory_evidence", "missing_memory_id");
                continue;
            };
            let mapped: Option<String> = transaction
                .query_row(
                    "SELECT v2_id FROM migration_id_map WHERE v1_id = ?1",
                    params![v1_memory_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(memory_id) = mapped else {
                resolve(counts, "memory_evidence", "orphan_memory_reference");
                continue;
            };
            let Some(evidence_key) = value_str(row, "evidence_key") else {
                resolve(counts, "memory_evidence", "missing_evidence_key");
                continue;
            };
            let linked = value_str(row, "linked_at")
                .and_then(|value| parse_iso_ms(&value))
                .unwrap_or(now_ms);
            let retired = value_str(row, "retired_at")
                .filter(|value| !value.is_empty())
                .and_then(|value| parse_iso_ms(&value));
            transaction.execute(
                "INSERT INTO memory_evidence (memory_id, source_id, generation, evidence_key, role, \
                 created_ms, retired_ms) VALUES (?1, 'v1-import', ?2, ?3, NULL, ?4, ?5) \
                 ON CONFLICT (memory_id, source_id, generation, evidence_key) DO UPDATE SET \
                 retired_ms = excluded.retired_ms",
                params![memory_id, run_id, evidence_key, linked, retired],
            )?;
            bump(counts, "memory_evidence");
        }
        transaction.execute(
            "UPDATE migration_manifest SET cursor_json = ?2, counts_json = ?3 WHERE run_id = ?1",
            params![
                run_id,
                serde_json::to_string(cursor)?,
                serde_json::to_string(counts)?
            ],
        )?;
        transaction.commit()?;
        cursor.insert("memory_evidence".to_string(), position);
    }
    Ok(())
}

fn import_repository_mappings(
    store: &Store,
    source: &Connection,
    run_id: &str,
    cursor: &mut BTreeMap<String, i64>,
    counts: &mut MigrateCounts,
    now_ms: i64,
) -> CoreResult<()> {
    let mut position = *cursor.get("repository_identity_mapping").unwrap_or(&0);
    loop {
        let chunk = read_chunk(source, "repository_identity_mapping", position)?;
        if chunk.is_empty() {
            break;
        }
        let mut connection = store.writer.lock().expect("writer lock");
        let transaction = connection.transaction()?;
        for (rowid, row) in &chunk {
            position = *rowid;
            let Some(legacy) = value_str(row, "legacy") else {
                resolve(counts, "repository_identity_mapping", "missing_legacy");
                continue;
            };
            let Some(canonical) = value_str(row, "canonical") else {
                resolve(counts, "repository_identity_mapping", "missing_canonical");
                continue;
            };
            // Ambiguous aliases (one legacy, several canonicals) are
            // quarantined rather than guessed.
            let ambiguous: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM repository_mappings WHERE legacy = ?1 AND canonical <> ?2",
                params![legacy, canonical],
                |row| row.get(0),
            )?;
            transaction.execute(
                "INSERT INTO repository_mappings (legacy, canonical, ambiguous, created_ms) \
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT (legacy, canonical) DO NOTHING",
                params![legacy, canonical, i64::from(ambiguous > 0), now_ms],
            )?;
            bump(counts, "repository_identity_mapping");
        }
        transaction.execute(
            "UPDATE migration_manifest SET cursor_json = ?2, counts_json = ?3 WHERE run_id = ?1",
            params![
                run_id,
                serde_json::to_string(cursor)?,
                serde_json::to_string(counts)?
            ],
        )?;
        transaction.commit()?;
        cursor.insert("repository_identity_mapping".to_string(), position);
    }
    Ok(())
}

fn remap_supersessions(store: &Store, _run_id: &str) -> CoreResult<()> {
    let connection = store.writer.lock().expect("writer lock");
    connection.execute(
        "UPDATE memories SET superseded_by = ( \
           SELECT target.v2_id FROM migration_supersession supersession \
           JOIN migration_id_map target ON target.v1_id = supersession.superseded_by_v1 \
           JOIN migration_id_map source ON source.v1_id = supersession.v1_id \
           WHERE source.v2_id = memories.id) \
         WHERE id IN ( \
           SELECT source.v2_id FROM migration_supersession supersession \
           JOIN migration_id_map source ON source.v1_id = supersession.v1_id)",
        [],
    )?;
    Ok(())
}

fn rebuild_metadata(store: &Store, now_ms: i64) -> CoreResult<()> {
    let mut connection = store.writer.lock().expect("writer lock");
    let transaction = connection.transaction()?;
    let active: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL",
        [],
        |row| row.get(0),
    )?;
    // Suppressions imported from v1 mark rows forgotten; the counter must
    // reflect them or Status and the dashboard under-report deletions.
    let forgotten: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM memories WHERE forgotten = 1",
        [],
        |row| row.get(0),
    )?;
    let revision: i64 =
        transaction.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))?;
    transaction.execute(
        "UPDATE store_metadata SET active_memories = ?1, forgotten_memories = ?2, \
         memory_revision = ?3 WHERE id = 1",
        params![active, forgotten, revision],
    )?;
    let _ = now_ms;
    transaction.commit()?;
    Ok(())
}

/// One quarantined v1 row: id, kind, content, confidence, scope, session,
/// created, updated, expires, topic key, tags, metadata.
type UnscopedRow = (
    String,
    String,
    String,
    f64,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
);

impl Store {
    /// Import the rows the conservative migration quarantined: repo-scoped
    /// memories with no repository identity anywhere. This is an explicit
    /// operator choice — they become global instead of staying behind — and
    /// suppression state is carried over so nothing forgotten is resurrected.
    /// Safe against a live store: deterministic ids make it idempotent.
    pub fn import_unscoped_as_global(
        &self,
        source: &std::path::Path,
        apply: bool,
        now_ms: i64,
    ) -> CoreResult<serde_json::Value> {
        let source_connection = rusqlite::Connection::open_with_flags(
            source,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let rows: Vec<UnscopedRow> = {
            let mut statement = source_connection.prepare(
                "SELECT id, type, content, confidence, scope, source_session_id, created_at, \
                 updated_at, expires_at, canonical_key, COALESCE(tags, ''), COALESCE(metadata_json, '') \
                 FROM semantic_memory \
                 WHERE (repository IS NULL OR repository = '') \
                 AND scope IN ('repo', 'transferable') \
                 ORDER BY created_at ASC",
            )?;
            let mapped = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            })?;
            mapped.collect::<Result<Vec<_>, _>>()?
        };
        let suppressed: std::collections::HashSet<String> = {
            let mut statement =
                source_connection.prepare("SELECT memory_id FROM memory_suppression")?;
            let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
            mapped.collect::<Result<_, _>>()?
        };
        let found = rows.len() as i64;
        if !apply {
            return Ok(serde_json::json!({
                "found": found,
                "suppressed": rows
                    .iter()
                    .filter(|row| suppressed.contains(&row.0))
                    .count() as i64,
                "apply": false,
                "scope": "global",
            }));
        }

        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let generation: String = transaction
            .query_row(
                "SELECT generation FROM memory_evidence LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_else(|| "v1-unscoped".to_string());
        let mut imported = 0i64;
        let mut already = 0i64;
        let mut suppressed_rows = 0i64;
        let mut linked = 0i64;
        for row in &rows {
            let (
                v1_id,
                kind,
                content,
                confidence,
                source_scope,
                session,
                created_at,
                updated_at,
                expires_at,
                topic_key,
                tags_raw,
                metadata,
            ) = row;
            // A transferable row keeps its scope: it was never repository-bound.
            // A transferable row without a repository is not representable in
            // the v2 schema (non-global scopes must name one), so the operator
            // chose global for the whole quarantined set.
            let _ = source_scope;
            let target_scope = "global";
            let Some(created) = parse_iso_ms(created_at) else {
                continue;
            };
            let updated = parse_iso_ms(updated_at).unwrap_or(created);
            let expires = expires_at.as_deref().and_then(parse_iso_ms);
            let (memory_id, _remapped) = map_id(v1_id);
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM memories WHERE id = ?1)",
                params![memory_id],
                |row| row.get(0),
            )?;
            if exists {
                already += 1;
                continue;
            }
            let is_suppressed = suppressed.contains(v1_id);
            let body = if is_suppressed {
                String::new()
            } else {
                content.clone()
            };
            let content_hash = crate::store::content_hash(&body);
            let tags: Vec<String> = tags_raw
                .split([',', ';'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect();
            let authority = if metadata.contains("manual") {
                "manual"
            } else {
                "auto"
            };
            let topic = topic_key
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| crate::store::content_hash(content));
            transaction.execute(
                "INSERT INTO memories (id, kind, content, content_hash, scope, repository, authority, \
                 confidence, tags_json, source_session_id, created_ms, updated_ms, expires_at_ms, \
                 revision, forgotten, topic_key, superseded_by) \
                 VALUES (?1, ?2, ?3, ?4, ?14, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?13, NULL) \
                 ON CONFLICT (id) DO NOTHING",
                params![
                    memory_id,
                    kind,
                    body,
                    content_hash,
                    authority,
                    confidence,
                    serde_json::to_string(&tags)?,
                    session,
                    created,
                    updated,
                    expires,
                    i64::from(is_suppressed),
                    topic,
                    target_scope,
                ],
            )?;
            if is_suppressed {
                transaction.execute(
                    "INSERT INTO suppressions (memory_id, scope, repository, fingerprint, reason, \
                     revision, created_ms, state) VALUES (?1, ?2, NULL, ?3, 'migrated_v1', 1, ?4, 'active')",
                    params![memory_id, target_scope, content_hash, now_ms],
                )?;
                suppressed_rows += 1;
            } else {
                transaction.execute(
                    "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, ?2, ?3, ?4)",
                    params![body, kind, tags.join(" "), memory_id],
                )?;
                transaction.execute(
                    "INSERT OR IGNORE INTO embedding_intents \
                     (memory_id, desired_revision, state, attempts, next_attempt_ms, terminal_reason, \
                      content_hash, model_identity, updated_ms) \
                     VALUES (?1, 1, 'pending', 0, NULL, NULL, ?2, '', ?3)",
                    params![memory_id, content_hash, now_ms],
                )?;
            }
            // Carry the evidence links the main import could not attach.
            let mut statement = source_connection.prepare(
                "SELECT evidence_key, linked_at, retired_at FROM memory_evidence \
                 WHERE memory_id = ?1 LIMIT 50",
            )?;
            let evidence = statement.query_map(params![v1_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?;
            for entry in evidence {
                let (evidence_key, linked_at, retired_at) = entry?;
                let linked_ms = parse_iso_ms(&linked_at).unwrap_or(now_ms);
                let retired_ms = retired_at.as_deref().and_then(parse_iso_ms);
                transaction.execute(
                    "INSERT INTO memory_evidence (memory_id, source_id, generation, evidence_key, role, \
                     created_ms, retired_ms) VALUES (?1, 'v1-import', ?2, ?3, NULL, ?4, ?5) \
                     ON CONFLICT (memory_id, source_id, generation, evidence_key) DO NOTHING",
                    params![memory_id, generation, evidence_key, linked_ms, retired_ms],
                )?;
                linked += 1;
            }
            imported += 1;
        }
        transaction.execute(
            "UPDATE store_metadata SET memory_revision = (SELECT COUNT(*) FROM memories), \
             active_memories = (SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL), \
             forgotten_memories = (SELECT COUNT(*) FROM memories WHERE forgotten = 1) WHERE id = 1",
            [],
        )?;
        transaction.commit()?;
        Ok(serde_json::json!({
            "found": found,
            "imported": imported,
            "alreadyPresent": already,
            "suppressed": suppressed_rows,
            "evidenceLinked": linked,
            "apply": true,
            "scope": "global",
        }))
    }
}
