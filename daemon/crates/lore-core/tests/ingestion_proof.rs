//! Stage-4 capture behaviour: golden parsers per client, checkpoint
//! continuity and generation resets, gaps, and read-only source databases.

use std::path::{Path, PathBuf};

use lore_core::config::{Limits, ResolvedConfig, ResolvedSourceRoot, ResolvedSources};
use lore_core::ingestion::{capture_source, parsers::ParserState, register_hinted_source};
use lore_core::store::Store;

const PI: &str = include_str!("../../../../tests/v2/fixtures/sources/pi.jsonl");
const CODEX: &str = include_str!("../../../../tests/v2/fixtures/sources/codex.jsonl");
const CLAUDE: &str = include_str!("../../../../tests/v2/fixtures/sources/claude.jsonl");
const ANTIGRAVITY: &str =
    include_str!("../../../../tests/v2/fixtures/sources/antigravity.jsonl");

fn sources_dir(dir: &Path) -> PathBuf {
    let path = dir.join("sources");
    std::fs::create_dir_all(&path).expect("sources dir");
    path
}

fn config(dir: &Path, client: &str, repository: Option<&str>) -> ResolvedConfig {
    ResolvedConfig {
        enabled: true,
        config_path: None,
        data_dir: dir.to_path_buf(),
        socket_path: dir.join("test.sock"),
        store_path: dir.join("lore-v2.db"),
        limits: Limits::default(),
        embedding_identity: None,
        embedding: None,
        sources: ResolvedSources {
            roots: vec![ResolvedSourceRoot {
                root_id: format!("{client}-root"),
                client: client.to_string(),
                path: sources_dir(dir),
                repository: repository.map(str::to_string),
            }],
            sweep_seconds: 60,
            page_entries: 256,
            quantum_bytes: 64 * 1024,
            max_record_bytes: 1024 * 1024,
        },
    }
}

fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = sources_dir(dir).join(name);
    std::fs::write(&path, contents).expect("write source");
    path
}

fn register(store: &Store, config: &ResolvedConfig, path: &Path, hint: Option<&str>) -> lore_core::store::SourceRow {
    register_hinted_source(
        store,
        &config.sources.roots[0],
        path,
        hint,
        None,
        1_000,
    )
    .expect("register")
}

fn capture(store: &Store, config: &ResolvedConfig, row: &lore_core::store::SourceRow, now: i64) -> lore_core::ingestion::CaptureReport {
    capture_source(store, &config.sources, row, now)
}

fn parse_all(client: &str, contents: &str) -> Vec<lore_core::store::SourceRecord> {
    let mut parser = lore_core::ingestion::parsers::LineParser::new(client, "fixture", ParserState::default());
    let mut records = Vec::new();
    for line in contents.lines() {
        records.extend(parser.parse(line).records);
    }
    records
}

#[test]
fn pi_golden_fixture_normalizes_session_turns_tools_and_summaries() {
    let records = parse_all("pi", PI);
    let kinds: Vec<&str> = records.iter().map(|record| record.kind.as_str()).collect();
    assert_eq!(kinds, vec!["session", "user_turn", "assistant_turn", "tool", "summary"]);
    assert_eq!(records[1].turn_index, Some(1));
    assert_eq!(records[2].role.as_deref(), Some("assistant"));
    assert!(records[3].text.contains("capture.mjs"));
    assert_eq!(records[4].completeness, "summary");
}

#[test]
fn codex_golden_fixture_skips_analysis_channels() {
    let records = parse_all("codex", CODEX);
    let kinds: Vec<&str> = records.iter().map(|record| record.kind.as_str()).collect();
    assert_eq!(kinds, vec!["session", "user_turn", "assistant_turn"]);
    assert_eq!(records[1].turn_index, Some(1));
    assert!(records.iter().all(|record| !record.text.contains("internal reasoning")));
}

#[test]
fn claude_golden_fixture_preserves_parents_and_abandons_side_branches() {
    let mut parser = lore_core::ingestion::parsers::LineParser::new("claude", "cl-golden-1", ParserState::default());
    let mut records = Vec::new();
    let mut corrections = Vec::new();
    for line in CLAUDE.lines() {
        let parsed = parser.parse(line);
        records.extend(parsed.records);
        corrections.extend(parsed.corrections);
    }
    assert_eq!(records.len(), 4, "meta record is skipped: {records:?}");
    assert_eq!(records[0].parent_key, None);
    assert!(records[1].parent_key.as_deref().unwrap_or_default().ends_with('a'));
    // The last node returns to the main chain, so the side branch is abandoned.
    assert!(corrections.iter().any(|(_, completeness)| completeness == "abandoned"));
}

#[test]
fn antigravity_golden_fixture_revises_step_two() {
    let mut parser = lore_core::ingestion::parsers::LineParser::new("antigravity", "fixture", ParserState::default());
    let mut records = Vec::new();
    let mut corrections = Vec::new();
    for line in ANTIGRAVITY.lines() {
        let parsed = parser.parse(line);
        records.extend(parsed.records);
        corrections.extend(parsed.corrections);
    }
    assert_eq!(records.len(), 3);
    assert_eq!(records[0].kind, "user_turn");
    assert_eq!(records[1].turn_index, Some(1));
    assert_eq!(records[2].turn_index, Some(1));
    assert_eq!(corrections.len(), 1);
}

#[test]
fn capture_is_atomic_and_append_continues_the_generation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), "pi", None);
    let store = Store::open(&config).expect("open");
    let head: String = PI.lines().take(3).map(|line| format!("{line}\n")).collect();
    let path = write(dir.path(), "session.jsonl", &head);
    let row = register(&store, &config, &path, Some("pi-golden-1"));
    let report = capture(&store, &config, &row, 2_000);
    assert_eq!(report.state, "caught_up");
    let first_generation = report.generation.clone();
    let first_offset = report.offset;
    assert!(first_offset > 0);

    // Append: same generation, offset advances, no duplicate evidence.
    std::fs::write(&path, PI).expect("append");
    let row = store.source_by_id(&row.source_id).expect("get").expect("row");
    let report = capture(&store, &config, &row, 3_000);
    assert_eq!(report.generation, first_generation, "append keeps the generation");
    assert!(report.offset > first_offset);
    assert!(!report.reset);
    let count = store.source_record_count(&row.source_id, &report.generation).expect("count");
    assert_eq!(count, 5);

    // Re-capturing an unchanged source is a no-op.
    let row = store.source_by_id(&row.source_id).expect("get").expect("row");
    let report = capture(&store, &config, &row, 4_000);
    assert_eq!(report.records, 0);
    assert_eq!(report.offset, row.offset);
}

#[test]
fn truncation_and_replacement_start_a_new_generation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), "codex", None);
    let store = Store::open(&config).expect("open");
    let path = write(dir.path(), "session.jsonl", CODEX);
    let row = register(&store, &config, &path, Some("cx-golden-1"));
    let first = capture(&store, &config, &row, 2_000);
    assert!(first.records > 0);

    // Same-size replacement with different content resets the generation.
    let replaced = CODEX.replace("Which table stores extraction intent?", "Which table stores capture evidence?   ");
    std::fs::write(&path, replaced).expect("replace");
    let row = store.source_by_id(&row.source_id).expect("get").expect("row");
    let second = capture(&store, &config, &row, 3_000);
    assert_ne!(second.generation, first.generation);
    assert!(second.reset);
    assert_eq!(
        store.generation_disposition(&row.source_id, &first.generation).expect("disposition"),
        Some("superseded".to_string())
    );

    // Truncation below the committed offset also resets.
    std::fs::write(&path, &CODEX[..20]).expect("truncate");
    let row = store.source_by_id(&row.source_id).expect("get").expect("row");
    let third = capture(&store, &config, &row, 4_000);
    assert_ne!(third.generation, second.generation);
}

#[test]
fn trailing_partial_records_are_retained_and_oversized_records_are_skipped() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut config = config(dir.path(), "pi", None);
    config.sources.max_record_bytes = 2 * 1024;
    let store = Store::open(&config).expect("open");
    let oversized = format!("{{\"type\":\"message\",\"pad\":\"{}\"}}\n", "x".repeat(4 * 1024));
    let contents = format!("{}{}", PI, oversized);
    let path = write(dir.path(), "session.jsonl", &contents);
    let row = register(&store, &config, &path, Some("pi-golden-1"));
    let report = capture(&store, &config, &row, 2_000);
    assert_eq!(report.skipped, 1, "oversized record is counted, not materialized");
    assert_eq!(store.source_record_count(&row.source_id, &report.generation).expect("count"), 5);
    assert!(store
        .source_records(&row.source_id, &report.generation, 100)
        .expect("records")
        .iter()
        .all(|record| record.text.len() < 64 * 1024));

    // A partial trailing line is not consumed until it completes.
    let mut partial = PI.replace("pi-golden-1", "pi-partial-1");
    partial.truncate(partial.len() - 10);
    let path = write(dir.path(), "partial.jsonl", &partial);
    let row = register(&store, &config, &path, Some("pi-partial-1"));
    let report = capture(&store, &config, &row, 3_000);
    assert_eq!(report.state, "growing");
    assert!(report.offset < std::fs::metadata(&path).expect("meta").len() as i64);
    assert_eq!(store.source_record_count(&row.source_id, &report.generation).expect("count"), 4);
    std::fs::write(&path, PI.replace("pi-golden-1", "pi-partial-1")).expect("complete");
    let row = store.source_by_id(&row.source_id).expect("get").expect("row");
    let report = capture(&store, &config, &row, 4_000);
    assert_eq!(report.state, "caught_up");
    assert_eq!(store.source_record_count(&row.source_id, &report.generation).expect("count"), 5);
}

#[test]
fn missing_and_symlinked_sources_never_delete_evidence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), "pi", None);
    let store = Store::open(&config).expect("open");
    let path = write(dir.path(), "session.jsonl", PI);
    let row = register(&store, &config, &path, Some("pi-golden-1"));
    let first = capture(&store, &config, &row, 2_000);
    assert_eq!(store.source_record_count(&row.source_id, &first.generation).expect("count"), 5);

    std::fs::remove_file(&path).expect("remove");
    let row = store.source_by_id(&row.source_id).expect("get").expect("row");
    let report = capture(&store, &config, &row, 3_000);
    assert_eq!(report.state, "unavailable");
    assert_eq!(store.source_record_count(&row.source_id, &first.generation).expect("count"), 5);

    // A symlink escaping the approved root is rejected as ambiguous.
    let outside = tempfile::tempdir().expect("outside");
    let target = outside.path().join("elsewhere.jsonl");
    std::fs::write(&target, PI).expect("outside file");
    let link = sources_dir(dir.path()).join("link.jsonl");
    std::os::unix::fs::symlink(&target, &link).expect("symlink");
    let error = register_hinted_source(&store, &config.sources.roots[0], &link, None, None, 4_000)
        .expect_err("symlink escaping the root is rejected");
    assert_eq!(error.reason, "SOURCE_ESCAPED_ROOT");
}

#[test]
fn capture_conflicts_do_not_advance_offsets() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), "pi", None);
    let store = Store::open(&config).expect("open");
    let path = write(dir.path(), "session.jsonl", PI);
    let row = register(&store, &config, &path, Some("pi-golden-1"));
    let first = capture(&store, &config, &row, 2_000);
    // A second capture built on the pre-commit row must not move the checkpoint.
    let stale = capture(&store, &config, &row, 3_000);
    assert!(stale.conflict || stale.offset == row.offset);
    let current = store.source_by_id(&row.source_id).expect("get").expect("row");
    assert_eq!(current.offset, first.offset);
}

#[test]
fn copilot_sources_are_read_only() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), "copilot", None);
    let store = Store::open(&config).expect("open");
    let path = sources_dir(dir.path()).join("session-store.db");
    {
        let connection = rusqlite::Connection::open(&path).expect("open db");
        connection
            .execute_batch(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT, \
                 summary TEXT, created_at TEXT, updated_at TEXT); \
                 CREATE TABLE turns (session_id TEXT, turn_index INTEGER, user_message TEXT, \
                 assistant_response TEXT, timestamp TEXT); \
                 INSERT INTO sessions VALUES ('s1', '/work', 'owner/name', 'main', '', \
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z'); \
                 INSERT INTO turns VALUES ('s1', 1, 'What is captured?', 'Rows and revisions.', \
                 '2026-01-01T00:00:05Z');",
            )
            .expect("schema");
    }
    let before = std::fs::metadata(&path).expect("meta").len();
    let row = register(&store, &config, &path, None);
    let report = capture(&store, &config, &row, 2_000);
    assert_eq!(report.state, "caught_up");
    assert_eq!(store.source_record_count(&row.source_id, &report.generation).expect("count"), 3);
    let after = std::fs::metadata(&path).expect("meta").len();
    assert_eq!(before, after, "host database bytes are untouched");

    // Updates are picked up as new evidence revisions.
    {
        let connection = rusqlite::Connection::open(&path).expect("reopen");
        connection
            .execute(
                "UPDATE turns SET assistant_response = 'Rows, revisions and deletion.' WHERE turn_index = 1",
                [],
            )
            .expect("update");
        connection
            .execute(
                "INSERT INTO turns VALUES ('s1', 2, 'Second?', 'Second answer.', '2026-01-01T00:00:06Z')",
                [],
            )
            .expect("insert");
    }
    let row = store.source_by_id(&row.source_id).expect("get").expect("row");
    let report = capture(&store, &config, &row, 3_000);
    assert!(report.records >= 2, "changed and new turns are captured: {report:?}");
}

#[test]
fn unknown_sqlite_schema_fails_without_hot_looping() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), "copilot", None);
    let store = Store::open(&config).expect("open");
    let path = sources_dir(dir.path()).join("other.db");
    rusqlite::Connection::open(&path)
        .expect("open db")
        .execute_batch("CREATE TABLE unrelated (id INTEGER);")
        .expect("schema");
    let row = register(&store, &config, &path, None);
    let report = capture(&store, &config, &row, 2_000);
    assert_eq!(report.state, "failed");
    assert_eq!(report.reason.as_deref(), Some("SOURCE_UNKNOWN_SCHEMA"));
}

#[test]
fn unresolved_repository_hints_stay_unverified() {
    let dir = tempfile::tempdir().expect("tempdir");
    let verified_config = {
        let mut value = config(dir.path(), "pi", Some("owner/verified"));
        value.sources.roots[0].root_id = "pi-verified-root".to_string();
        value
    };
    let config = config(dir.path(), "pi", None);
    let store = Store::open(&config).expect("open");
    let path = write(dir.path(), "session.jsonl", PI);
    let row = register_hinted_source(
        &store,
        &config.sources.roots[0],
        &path,
        Some("pi-golden-1"),
        Some("owner/name"),
        1_000,
    )
    .expect("register");
    assert_eq!(row.repository.as_deref(), Some("owner/name"));
    assert!(!row.repository_verified, "a hint alone is not verified identity");

    let verified = register_hinted_source(
        &store,
        &verified_config.sources.roots[0],
        &path,
        Some("pi-golden-1"),
        Some("ignored/hint"),
        1_000,
    )
    .expect("register verified");
    assert!(verified.repository_verified);
}

#[test]
fn source_identity_mismatch_is_rejected() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path(), "pi", None);
    let store = Store::open(&config).expect("open");
    let path = write(dir.path(), "session.jsonl", PI);
    let error = register_hinted_source(
        &store,
        &config.sources.roots[0],
        &path,
        Some("not-the-header-id"),
        None,
        1_000,
    )
    .expect_err("mismatched native identity");
    assert_eq!(error.reason, "SOURCE_IDENTITY_MISMATCH");
}
