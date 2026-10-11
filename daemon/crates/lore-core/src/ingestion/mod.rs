//! Background source discovery and checkpointed transcript capture.
//!
//! Capture is bounded, append-friendly and crash-safe: one quantum is read,
//! normalized and committed under a checkpoint compare-and-swap transaction.
//! Missing or replaced sources never delete previously verified evidence.

pub mod parsers;

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::{ResolvedSourceRoot, ResolvedSources};
use crate::error::{CoreError, CoreResult};
use crate::store::{CaptureCommit, SourceRecord, SourceRow, Store, open_readonly};
use parsers::{LineParser, ParserState, TurnCursor, matches_client};

const ANCHOR_BYTES: usize = 4 * 1024;
/// Sources captured per root per sweep before yielding to the next sweep.
pub const CAPTURE_PER_ROOT: usize = 256;
/// Pending sources revisited per sweep (large files progress over sweeps).
pub const PENDING_PER_SWEEP: usize = 16;
const MAX_SQLITE_PAGE: usize = 256;

/// Outcome of one capture quantum.
#[derive(Debug, Clone)]
pub struct CaptureReport {
    pub source_id: String,
    pub generation: String,
    pub state: String,
    pub observed_size: i64,
    pub offset: i64,
    pub records: usize,
    pub skipped: usize,
    pub reset: bool,
    pub conflict: bool,
    pub reason: Option<String>,
}

/// Outcome of one discovery sweep.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepReport {
    pub roots: usize,
    pub discovered: usize,
    pub captured: usize,
    pub pending: usize,
    pub unavailable: usize,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Canonicalize an approved source path and reject escapes. The returned path
/// is the canonical path used for identity; validation happens before every
/// open, not only at registration.
pub fn safe_source_path(
    root: &ResolvedSourceRoot,
    path: &Path,
    expect_file: bool,
) -> CoreResult<PathBuf> {
    let canonical_root = std::fs::canonicalize(&root.path)
        .map_err(|error| CoreError::precondition("SOURCE_ROOT_UNAVAILABLE", format!("{error}")))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| CoreError::precondition("SOURCE_UNAVAILABLE", format!("{error}")))?;
    if metadata.file_type().is_symlink() {
        return Err(CoreError::precondition(
            "SOURCE_ESCAPED_ROOT",
            "source path is a symbolic link",
        ));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| CoreError::precondition("SOURCE_UNAVAILABLE", format!("{error}")))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(CoreError::precondition(
            "SOURCE_ESCAPED_ROOT",
            "source path escapes its approved root",
        ));
    }
    if expect_file && !metadata.is_file() {
        return Err(CoreError::precondition(
            "SOURCE_NOT_A_FILE",
            "source path is not a regular file",
        ));
    }
    Ok(canonical)
}

/// Read from `offset` until at least one complete line is available, the file
/// ends, or a record exceeds `max_record` bytes. A trailing incomplete record
/// is retained for a later sweep. Returns complete lines, the new offset, and
/// whether an oversized record was consumed so the caller can count it.
///
/// A record longer than one quantum must still finish: stopping at the
/// quantum would leave the offset where it was, and every later sweep would
/// reread the same bytes.
fn read_quantum(
    file: &mut std::fs::File,
    offset: i64,
    quantum: usize,
    max_record: usize,
) -> CoreResult<(Vec<Vec<u8>>, i64, bool)> {
    file.seek(SeekFrom::Start(offset as u64))?;
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let mut chunk = vec![0u8; quantum.max(1)];
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.contains(&b'\n') || buffer.len() > max_record {
            break;
        }
    }
    let mut lines = Vec::new();
    let mut start = 0usize;
    while let Some(newline) = buffer[start..].iter().position(|byte| *byte == b'\n') {
        let end = start + newline;
        lines.push(buffer[start..end].to_vec());
        start = end + 1;
    }
    if lines.is_empty() && buffer.len() > max_record {
        // No newline within the record limit: consume the oversized prefix so
        // capture moves on. The caller counts it as skipped.
        return Ok((Vec::new(), offset + buffer.len() as i64, true));
    }
    Ok((lines, offset + start as i64, false))
}

fn hash_prefix(file: &mut std::fs::File, size: i64) -> CoreResult<Option<String>> {
    let length = (ANCHOR_BYTES as i64).min(size) as usize;
    hash_length(file, length)
}

/// Hash exactly `length` bytes from the start of the file. When comparing
/// against a prior checkpoint the caller passes the length observed at that
/// checkpoint, so appends cannot masquerade as replacement.
fn hash_length(file: &mut std::fs::File, length: usize) -> CoreResult<Option<String>> {
    if length == 0 {
        return Ok(None);
    }
    let mut buffer = vec![0u8; length];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut buffer)?;
    Ok(Some(sha256_hex(&buffer)))
}

fn hash_boundary(file: &mut std::fs::File, offset: i64) -> CoreResult<Option<String>> {
    let length = (ANCHOR_BYTES as i64).min(offset) as usize;
    if length == 0 {
        return Ok(None);
    }
    let mut buffer = vec![0u8; length];
    file.seek(SeekFrom::Start((offset - length as i64) as u64))?;
    file.read_exact(&mut buffer)?;
    Ok(Some(sha256_hex(&buffer)))
}

fn parser_state(row: &SourceRow, store: &Store) -> ParserState {
    store
        .source_parser_state(&row.source_id, &row.generation)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Capture one bounded quantum for a source. Never advances a checkpoint
/// without the records that belong to it.
pub fn capture_source(
    store: &Store,
    sources: &ResolvedSources,
    row: &SourceRow,
    now_ms: i64,
) -> CaptureReport {
    let mut report = CaptureReport {
        source_id: row.source_id.clone(),
        generation: row.generation.clone(),
        state: row.state.clone(),
        observed_size: row.observed_size,
        offset: row.offset,
        records: 0,
        skipped: 0,
        reset: false,
        conflict: false,
        reason: None,
    };
    let root = match sources
        .roots
        .iter()
        .find(|root| root.root_id == row.root_id)
    {
        Some(root) => root,
        None => {
            report.state = "unavailable".into();
            report.reason = Some("SOURCE_ROOT_UNAVAILABLE".into());
            let _ = store.mark_source_state(
                &row.source_id,
                "unavailable",
                Some("SOURCE_ROOT_UNAVAILABLE"),
                None,
                row.pending_bytes,
                now_ms,
            );
            return report;
        }
    };
    let path = match safe_source_path(root, Path::new(&row.canonical_path), true) {
        Ok(path) => path,
        Err(error) => {
            let (state, reason) = match error.code.as_str() {
                "SOURCE_ESCAPED_ROOT" => ("ambiguous", "SOURCE_AMBIGUOUS"),
                _ => ("unavailable", "SOURCE_UNAVAILABLE"),
            };
            let _ = store.mark_source_state(
                &row.source_id,
                state,
                Some(reason),
                None,
                row.pending_bytes,
                now_ms,
            );
            report.state = state.into();
            report.reason = Some(reason.into());
            return report;
        }
    };
    if row.client == "copilot" {
        return capture_copilot(store, &path, row, now_ms);
    }
    capture_jsonl(store, sources, row, &path, now_ms, &mut report);
    report
}

fn capture_jsonl(
    store: &Store,
    sources: &ResolvedSources,
    row: &SourceRow,
    path: &Path,
    now_ms: i64,
    report: &mut CaptureReport,
) {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => {
            report.state = "unavailable".into();
            report.reason = Some("SOURCE_UNAVAILABLE".into());
            let _ = store.mark_source_state(
                &row.source_id,
                "unavailable",
                Some("SOURCE_UNAVAILABLE"),
                None,
                row.pending_bytes,
                now_ms,
            );
            return;
        }
    };
    let metadata = match file.metadata() {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => {
            report.state = "ambiguous".into();
            report.reason = Some("SOURCE_NOT_A_FILE".into());
            return;
        }
        Err(_) => {
            report.state = "unavailable".into();
            report.reason = Some("SOURCE_UNAVAILABLE".into());
            return;
        }
    };
    // Reject a pathname swap between canonicalization and open.
    if let Ok(path_metadata) = std::fs::symlink_metadata(path)
        && path_metadata.file_type().is_symlink()
    {
        report.state = "ambiguous".into();
        report.reason = Some("SOURCE_AMBIGUOUS".into());
        return;
    }
    let observed_size = metadata.len() as i64;
    report.observed_size = observed_size;
    // Compare exactly the bytes present at the previous checkpoint, then store
    // the hash for the extent observed now.
    let prior_prefix_length = (ANCHOR_BYTES as i64).min(row.observed_size).max(0) as usize;
    let prior_prefix = hash_length(&mut file, prior_prefix_length).ok().flatten();
    let prefix_hash = hash_prefix(&mut file, observed_size).ok().flatten();
    let boundary_hash = hash_boundary(&mut file, row.offset).ok().flatten();
    let anchored = observed_size >= row.offset
        && row.prefix_hash == prior_prefix
        && row.boundary_hash == boundary_hash;
    let (generation, generation_seq, offset, prefix_hash, _) = if anchored {
        (
            row.generation.clone(),
            row.generation_seq,
            row.offset,
            prefix_hash,
            boundary_hash,
        )
    } else {
        report.reset = observed_size != 0 || row.offset != 0;
        (
            Uuid::new_v4().to_string(),
            row.generation_seq + 1,
            0,
            prefix_hash,
            None,
        )
    };
    report.generation = generation.clone();

    let quantum = sources.quantum_bytes;
    let max_record = sources.max_record_bytes;
    let (lines, consumed_to, oversized) = match read_quantum(&mut file, offset, quantum, max_record)
    {
        Ok(value) => value,
        Err(_) => {
            report.state = "retry_wait".into();
            report.reason = Some("SOURCE_READ_FAILED".into());
            let _ = store.mark_source_state(
                &row.source_id,
                "retry_wait",
                Some("SOURCE_READ_FAILED"),
                None,
                row.pending_bytes,
                now_ms,
            );
            return;
        }
    };
    let mut parser = LineParser::new(
        &row.client,
        &path_identity(row, path),
        parser_state(row, store),
    );
    let mut records: Vec<SourceRecord> = Vec::new();
    let mut corrections: HashMap<String, String> = HashMap::new();
    let mut skipped = i64::from(oversized);
    for line in &lines {
        if line.len() > max_record {
            skipped += 1;
            continue;
        }
        let Ok(text) = std::str::from_utf8(line) else {
            skipped += 1;
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let parsed = parser.parse(text);
        if let Some(reason) = parsed.skip
            && reason != "ignored_record"
        {
            skipped += 1;
        }
        for (key, completeness) in parsed.corrections {
            corrections.insert(key, completeness);
        }
        records.extend(parsed.records);
    }
    for record in &mut records {
        if let Some(completeness) = corrections.get(&record.evidence_key) {
            record.completeness = completeness.clone();
        }
    }
    let pending = (observed_size - consumed_to).max(0);
    let state = if pending > 0 { "growing" } else { "caught_up" };
    let commit = CaptureCommit {
        source_id: row.source_id.clone(),
        expected_generation: row.generation.clone(),
        expected_offset: row.offset,
        generation: generation.clone(),
        generation_seq,
        observed_size,
        offset: consumed_to,
        prefix_hash,
        boundary_hash: hash_boundary(&mut file, consumed_to).ok().flatten(),
        parser_version: parser.version().to_string(),
        state: state.to_string(),
        skipped_records: row.skipped_records + skipped,
        pending_bytes: pending,
        last_error: None,
        records,
        retire: (!anchored).then(|| (row.generation.clone(), "superseded".into())),
        now_ms,
        parser_state: serde_json::to_string(&parser.state).unwrap_or_default(),
        corrections,
    };
    match store.commit_capture(&commit) {
        Ok(Some(outcome)) => {
            report.offset = consumed_to;
            report.records = outcome.inserted + outcome.updated;
            report.skipped = skipped as usize;
            report.state = state.into();
            report.reason = (skipped > 0).then(|| "SOURCE_GAPS".into());
        }
        Ok(None) => {
            report.conflict = true;
            report.state = "queued".into();
            report.reason = Some("SOURCE_CONFLICT".into());
        }
        Err(error) => {
            report.state = "failed".into();
            report.reason = Some(error.code.clone());
        }
    }
}

fn path_identity(row: &SourceRow, path: &Path) -> String {
    row.native_session_id
        .clone()
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// One turn of a Copilot session: (turn index, user, assistant, timestamp).
type SessionTurn = (i64, String, String, String);

/// A session as capture reads it: (id, updated stamp, cwd, repository).
type SessionHeader = (String, String, Option<String>, Option<String>);

/// Records one Copilot capture quantum gathers before it commits. A session that
/// does not fit waits for the next quantum, so a long history is never held in
/// memory, or in one write transaction, all at once.
const RECORDS_PER_QUANTUM: usize = 2_048;

fn session_header_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionHeader> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
}

/// One session's header by id, or None when the session no longer exists.
fn session_header(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> rusqlite::Result<Option<SessionHeader>> {
    let mut statement = connection.prepare(
        "SELECT id, COALESCE(updated_at, created_at, ''), cwd, repository FROM sessions WHERE id = ?1",
    )?;
    match statement.query_row(rusqlite::params![session_id], session_header_row) {
        Ok(header) => Ok(Some(header)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
}

/// One page of a session's turns after `after`. None when the session has a turn
/// with no index: paging by index would drop that turn silently, so the session
/// is refused and counted as a gap.
fn session_turn_page(
    connection: &rusqlite::Connection,
    session_id: &str,
    after: i64,
) -> rusqlite::Result<Option<Vec<SessionTurn>>> {
    let unindexed: i64 = connection.query_row(
        "SELECT COUNT(*) FROM turns WHERE session_id = ?1 AND turn_index IS NULL",
        rusqlite::params![session_id],
        |row| row.get(0),
    )?;
    if unindexed > 0 {
        return Ok(None);
    }
    let mut statement = connection.prepare(
        "SELECT turn_index, user_message, assistant_response, timestamp FROM turns \
         WHERE session_id = ?1 AND turn_index > ?2 ORDER BY turn_index ASC LIMIT ?3",
    )?;
    let page = statement
        .query_map(
            rusqlite::params![session_id, after, MAX_SQLITE_PAGE as i64],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(page))
}

/// Read changed rows from a Copilot-style session store. Host databases are
/// opened read-only and are never migrated or written. Each call captures one
/// bounded quantum; a session that does not fit resumes at its last turn.
fn capture_copilot(store: &Store, path: &Path, row: &SourceRow, now_ms: i64) -> CaptureReport {
    let mut report = CaptureReport {
        source_id: row.source_id.clone(),
        generation: row.generation.clone(),
        state: row.state.clone(),
        observed_size: row.observed_size,
        offset: row.offset,
        records: 0,
        skipped: 0,
        reset: false,
        conflict: false,
        reason: None,
    };
    let connection = match open_readonly(path) {
        Ok(connection) => connection,
        Err(error) => {
            report.state = "retry_wait".into();
            report.reason = Some(error.code.clone());
            return report;
        }
    };
    let schema_ok: bool = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'turns')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count >= 2)
        .unwrap_or(false);
    if !schema_ok {
        let _ = store.mark_source_state(
            &row.source_id,
            "failed",
            Some("SOURCE_UNKNOWN_SCHEMA"),
            None,
            0,
            now_ms,
        );
        report.state = "failed".into();
        report.reason = Some("SOURCE_UNKNOWN_SCHEMA".into());
        return report;
    }
    let mut state = parser_state(row, store);
    let mut next = match connection.prepare(
        "SELECT id, COALESCE(updated_at, created_at, ''), cwd, repository FROM sessions \
         WHERE COALESCE(updated_at, created_at, '') > ?1 OR (COALESCE(updated_at, created_at, '') = ?1 AND id > ?2) \
         ORDER BY COALESCE(updated_at, created_at, '') ASC, id ASC LIMIT 1",
    ) {
        Ok(statement) => statement,
        Err(_) => {
            report.state = "failed".into();
            report.reason = Some("SOURCE_UNKNOWN_SCHEMA".into());
            return report;
        }
    };
    let mut cursor = state.cursor.clone();
    // A session that an earlier quantum left part-way through its turns resumes first.
    let mut resume = state.turn_cursor.take();
    let mut records: Vec<SourceRecord> = Vec::new();
    let mut skipped = 0i64;
    let mut completed = 0i64;
    let mut complete = false;
    while records.len() < RECORDS_PER_QUANTUM {
        let (session, after) = match resume.take() {
            Some(TurnCursor {
                session_id,
                after,
                stamp,
            }) => match session_header(&connection, &session_id) {
                // Keep the stamp the pass ordered this session by, not the current
                // one: advancing the cursor by a newer stamp would skip sessions.
                Ok(Some((id, _current, cwd, repository))) => ((id, stamp, cwd, repository), after),
                // Deleted since the last quantum, so there is nothing left to resume.
                Ok(None) => continue,
                Err(_) => {
                    report.state = "failed".into();
                    report.reason = Some("SOURCE_UNREADABLE".into());
                    return report;
                }
            },
            None => {
                let (cursor_time, cursor_id) = cursor
                    .as_deref()
                    .and_then(|value| value.split_once('\u{1}'))
                    .map(|(time, id)| (time.to_string(), id.to_string()))
                    .unwrap_or_default();
                match next.query_row(
                    rusqlite::params![cursor_time, cursor_id],
                    session_header_row,
                ) {
                    Ok(session) => (session, i64::MIN),
                    Err(rusqlite::Error::QueryReturnedNoRows) => {
                        complete = true;
                        break;
                    }
                    Err(_) => {
                        report.state = "failed".into();
                        report.reason = Some("SOURCE_UNREADABLE".into());
                        return report;
                    }
                }
            }
        };
        let (session_id, updated_at, cwd, repository) = &session;
        let page = match session_turn_page(&connection, session_id, after) {
            Ok(Some(page)) => page,
            Ok(None) | Err(_) => {
                skipped += 1;
                completed += 1;
                cursor = Some(format!("{updated_at}\u{1}{session_id}"));
                continue;
            }
        };
        let more = page.len() == MAX_SQLITE_PAGE;
        let last_turn = page.last().map_or(after, |turn| turn.0);
        for (turn_index, user, assistant, _timestamp) in page {
            if !user.trim().is_empty() {
                records.push(SourceRecord {
                    evidence_key: format!("copilot:{session_id}:turn:{turn_index}:user"),
                    kind: "user_turn".into(),
                    role: Some("user".into()),
                    turn_index: Some(turn_index),
                    parent_key: None,
                    branch: Some(session_id.clone()),
                    text: user.clone(),
                    completeness: "complete".into(),
                    revision: 1,
                });
            }
            if !assistant.trim().is_empty() {
                records.push(SourceRecord {
                    evidence_key: format!("copilot:{session_id}:turn:{turn_index}:assistant"),
                    kind: "assistant_turn".into(),
                    role: Some("assistant".into()),
                    turn_index: Some(turn_index),
                    parent_key: None,
                    branch: Some(session_id.clone()),
                    text: assistant.clone(),
                    completeness: "complete".into(),
                    revision: 1,
                });
            }
            if user.trim().is_empty() && assistant.trim().is_empty() {
                skipped += 1;
            }
        }
        if more {
            // More turns follow. The loop reads them while the quantum has room;
            // otherwise the cursor below carries this turn into the next quantum.
            resume = Some(TurnCursor {
                session_id: session_id.clone(),
                after: last_turn,
                stamp: updated_at.clone(),
            });
            continue;
        }
        records.push(SourceRecord {
            evidence_key: format!("copilot:{session_id}:session"),
            kind: "session".into(),
            role: None,
            turn_index: None,
            parent_key: None,
            branch: None,
            text: cwd
                .clone()
                .or_else(|| repository.clone())
                .unwrap_or_default(),
            completeness: "complete".into(),
            revision: 1,
        });
        completed += 1;
        cursor = Some(format!("{updated_at}\u{1}{session_id}"));
    }
    state.turn_cursor = resume;
    // A completed pass resets the cursor so updates to already-seen sessions
    // are reconciled on the next sweep; revisions are rechecked before commit.
    state.cursor = (!complete).then(|| cursor.unwrap_or_default());
    let commit = CaptureCommit {
        source_id: row.source_id.clone(),
        expected_generation: row.generation.clone(),
        expected_offset: row.offset,
        generation: row.generation.clone(),
        generation_seq: row.generation_seq,
        observed_size: row.offset + completed,
        offset: row.offset + completed,
        prefix_hash: None,
        boundary_hash: None,
        parser_version: "1".into(),
        state: if complete {
            "caught_up".into()
        } else {
            "growing".into()
        },
        skipped_records: row.skipped_records + skipped,
        pending_bytes: if complete { 0 } else { 1 },
        last_error: None,
        records,
        retire: None,
        now_ms,
        parser_state: serde_json::to_string(&state).unwrap_or_default(),
        corrections: HashMap::new(),
    };
    match store.commit_capture(&commit) {
        Ok(Some(outcome)) => {
            report.records = outcome.inserted + outcome.updated;
            report.offset = commit.offset;
            report.observed_size = commit.observed_size;
            report.skipped = skipped as usize;
            report.state = commit.state;
            report.reason = (skipped > 0).then(|| "SOURCE_GAPS".into());
        }
        Ok(None) => {
            report.conflict = true;
            report.state = "queued".into();
        }
        Err(error) => {
            report.state = "failed".into();
            report.reason = Some(error.code.clone());
        }
    }
    report
}

/// Walk the next page of one approved root and register capturable sources.
/// Returns the number of sources registered plus the new cursor, or `None`
/// when the walk is complete.
/// How deep discovery walks below a root, and how many files it collects.
const MAX_DISCOVERY_DEPTH: usize = 4;
/// Largest candidate list one sweep builds. Beyond it the walk stops and the
/// scan is reported incomplete, so a truncated listing is never taken for the
/// whole directory.
const MAX_DISCOVERY_ENTRIES: usize = 200_000;

/// Whether a file under a root of this client is a session candidate, judged by
/// its extension. Only candidates count toward the discovery cap.
fn is_candidate(client: &str, path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    match client {
        "copilot" => matches!(extension, "db" | "sqlite" | "sqlite3"),
        "antigravity" => matches!(extension, "json" | "jsonl"),
        _ => extension == "jsonl",
    }
}

/// Collect candidate files under a root, bounded by depth and by `cap` on the
/// candidates it lists. Returns true when the cap stopped the walk before every
/// candidate was listed. Files that `accept` rejects are not listed and do not count.
fn collect_candidate_files(
    directory: &Path,
    max_depth: usize,
    cap: usize,
    accept: &dyn Fn(&Path) -> bool,
    out: &mut Vec<PathBuf>,
) -> std::io::Result<bool> {
    let mut queue: Vec<(PathBuf, usize)> = vec![(directory.to_path_buf(), 0)];
    while let Some((dir, depth)) = queue.pop() {
        let mut children: Vec<PathBuf> = std::fs::read_dir(&dir)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| !path.is_symlink())
            .collect();
        children.sort();
        for path in children {
            if path.is_dir() {
                if depth < max_depth {
                    queue.push((path, depth + 1));
                }
                continue;
            }
            if !accept(&path) {
                continue;
            }
            out.push(path);
            if out.len() >= cap {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub fn discover_page(
    store: &Store,
    root: &ResolvedSourceRoot,
    cursor: Option<&str>,
    page_entries: usize,
    now_ms: i64,
) -> CoreResult<(Vec<SourceRow>, Option<String>, bool)> {
    let directory = Path::new(&root.path);
    // Hosts nest sessions (Pi: <root>/<project>/<session>.jsonl, Claude:
    // <root>/<project>/<session>.jsonl), so discovery walks bounded depth
    // instead of only the root's immediate entries.
    let mut entries: Vec<PathBuf> = Vec::new();
    let truncated = collect_candidate_files(
        directory,
        MAX_DISCOVERY_DEPTH,
        MAX_DISCOVERY_ENTRIES,
        &|path: &Path| is_candidate(&root.client, path),
        &mut entries,
    )
    .map_err(|error| CoreError::precondition("SOURCE_ROOT_UNAVAILABLE", format!("{error}")))?;
    entries.sort();
    let start = match cursor {
        Some(cursor) => entries.partition_point(|path| path.to_string_lossy().as_ref() <= cursor),
        None => 0,
    };
    let page = &entries[start..entries.len().min(start + page_entries)];
    let mut registered = Vec::new();
    for path in page {
        let Some(row) = register_discovered(store, root, path, now_ms)? else {
            continue;
        };
        registered.push(row);
    }
    // A listing cut short by the cap is an error, not a partial success. Paging
    // cannot reach past the cap, so the sessions beyond it would be skipped by every
    // later sweep without anyone being told.
    if truncated {
        return Err(CoreError::precondition(
            "SOURCE_ROOT_TOO_LARGE",
            format!(
                "source root {} holds more than {MAX_DISCOVERY_ENTRIES} candidate files",
                root.root_id
            ),
        ));
    }
    let complete = start + page.len() >= entries.len();
    let next_cursor = page
        .last()
        .map(|path| path.to_string_lossy().to_string())
        .or_else(|| cursor.map(str::to_string));
    Ok((registered, next_cursor, complete))
}

fn register_discovered(
    store: &Store,
    root: &ResolvedSourceRoot,
    path: &Path,
    now_ms: i64,
) -> CoreResult<Option<SourceRow>> {
    if !is_candidate(&root.client, path) {
        return Ok(None);
    }
    let Ok(canonical) = safe_source_path(root, path, true) else {
        return Ok(None);
    };
    let (native, repository) = if root.client == "copilot" {
        (None, root.repository.clone())
    } else {
        // Hosts write bookkeeping records before the first turn (Claude Code
        // starts files with queue-operation lines), so scan a bounded window
        // for the record that identifies the client and session.
        let Some(header) = identity_line(&root.client, &canonical)? else {
            return Ok(None);
        };
        (
            header_identity(&root.client, &header),
            root.repository.clone(),
        )
    };
    let identity = native
        .clone()
        .unwrap_or_else(|| canonical.to_string_lossy().to_string());
    let source_id = crate::store::source_id_for(&root.client, &root.root_id, &identity);
    if let Some(existing) = store.source_by_id(&source_id)? {
        return Ok(Some(existing));
    }
    let (row, _) = store.register_source(
        &source_id,
        &root.client,
        &root.root_id,
        native.as_deref(),
        &canonical.to_string_lossy(),
        repository.as_deref(),
        repository.is_some(),
        &Uuid::new_v4().to_string(),
        parsers::PARSER_VERSION,
        now_ms,
    )?;
    Ok(Some(row))
}

/// The first line within a bounded window that identifies this client, or
/// `None` when the file is not one of its sessions.
fn identity_line(client: &str, path: &Path) -> CoreResult<Option<String>> {
    let mut file = std::fs::File::open(path)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let read = file.read(&mut buffer)?;
    buffer.truncate(read);
    let text = String::from_utf8_lossy(&buffer);
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(MAX_IDENTITY_SCAN_LINES)
        .find(|line| matches_client(client, line))
        .map(str::to_string))
}

/// How many leading records may precede a session's identifying record.
const MAX_IDENTITY_SCAN_LINES: usize = 64;

fn first_line(path: &Path) -> CoreResult<Option<String>> {
    let mut file = std::fs::File::open(path)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let read = file.read(&mut buffer)?;
    buffer.truncate(read);
    let text = String::from_utf8_lossy(&buffer);
    Ok(text
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string))
}

fn header_identity(client: &str, line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    match client {
        "codex" => value
            .pointer("/payload/id")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        "pi" => value
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        "claude" => value
            .get("sessionId")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        _ => None,
    }
}

/// Normalize a repository hint. Full remote transports go through the shared
/// resolver; a plain `owner/name` slug is already canonical.
fn normalize_repository_hint(value: &str) -> Option<String> {
    let text = value.trim();
    if let Some(canonical) = repository_identity::canonical_remote_identity(text) {
        return Some(canonical);
    }
    let mut parts = text.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    if parts.next().is_some()
        || owner.is_empty()
        || name.is_empty()
        || !owner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

/// Verify a hinted path and register it inside an approved root.
#[allow(clippy::too_many_arguments)]
pub fn register_hinted_source(
    store: &Store,
    root: &ResolvedSourceRoot,
    path: &Path,
    native_hint: Option<&str>,
    repository_hint: Option<&str>,
    now_ms: i64,
) -> CoreResult<SourceRow> {
    let canonical = safe_source_path(root, path, true)?;
    let (native, repository_verified, repository) = if root.client == "copilot" {
        let repository = repository_hint
            .and_then(normalize_repository_hint)
            .or_else(|| root.repository.clone());
        (
            native_hint.map(str::to_string),
            root.repository.is_some(),
            repository,
        )
    } else {
        let first = first_line(&canonical)?.unwrap_or_default();
        let derived = header_identity(&root.client, &first);
        if let (Some(hint), Some(derived)) = (native_hint, derived.as_deref())
            && hint != derived
        {
            return Err(CoreError::precondition(
                "SOURCE_IDENTITY_MISMATCH",
                "native session identity does not match the source header",
            ));
        }
        let repository = repository_hint
            .and_then(normalize_repository_hint)
            .or_else(|| root.repository.clone());
        (
            derived.or_else(|| native_hint.map(str::to_string)),
            root.repository.is_some(),
            repository,
        )
    };
    let identity = native
        .clone()
        .unwrap_or_else(|| canonical.to_string_lossy().to_string());
    let source_id = crate::store::source_id_for(&root.client, &root.root_id, &identity);
    let (row, _) = store.register_source(
        &source_id,
        &root.client,
        &root.root_id,
        native.as_deref(),
        &canonical.to_string_lossy(),
        repository.as_deref(),
        repository_verified,
        &Uuid::new_v4().to_string(),
        parsers::PARSER_VERSION,
        now_ms,
    )?;
    Ok(row)
}

/// Resolve a configured root by ID and client, rejecting client mismatches.
pub fn root_for<'a>(
    sources: &'a ResolvedSources,
    root_id: &str,
    client: &str,
) -> CoreResult<&'a ResolvedSourceRoot> {
    sources
        .roots
        .iter()
        .find(|root| root.root_id == root_id)
        .filter(|root| root.client == client)
        .ok_or_else(|| {
            CoreError::precondition(
                "SOURCE_ROOT_NOT_APPROVED",
                "source root is not approved for this client",
            )
        })
}

/// Lexically normalizing helper: reject `..` components in configured roots
/// before they are used for any filesystem call.
pub fn reject_relative_escape(path: &Path) -> CoreResult<()> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(CoreError::precondition(
            "SOURCE_ROOT_INVALID",
            "source root must not contain parent traversal",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_walk_stopped_by_the_cap_reports_truncation() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["a.jsonl", "b.jsonl", "c.jsonl"] {
            std::fs::write(dir.path().join(name), "{}\n").expect("write");
        }
        let mut listed = Vec::new();
        assert!(
            collect_candidate_files(dir.path(), 1, 2, &|_: &Path| true, &mut listed).expect("walk")
        );
        let mut all = Vec::new();
        assert!(
            !collect_candidate_files(dir.path(), 1, 10, &|_: &Path| true, &mut all).expect("walk")
        );
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn unsupported_files_do_not_count_toward_the_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        for index in 0..5 {
            std::fs::write(dir.path().join(format!("cache-{index}.bin")), "x").expect("write");
        }
        std::fs::write(dir.path().join("session.jsonl"), "{}\n").expect("write");
        let mut listed = Vec::new();
        let truncated = collect_candidate_files(
            dir.path(),
            1,
            2,
            &|path: &Path| is_candidate("pi", path),
            &mut listed,
        )
        .expect("walk");
        assert!(!truncated, "five unsupported files must not stop the walk");
        assert_eq!(listed, vec![dir.path().join("session.jsonl")]);
    }
}
