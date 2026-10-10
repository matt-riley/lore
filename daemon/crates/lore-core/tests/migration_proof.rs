//! Stage-5B migration, backup and recovery proofs.

use std::path::{Path, PathBuf};

use lore_core::config::{Limits, ResolvedConfig};
use lore_core::migration::{self, backup};
use lore_core::store::Store;
use protocol::{ForgetParams, RetainParams, Scope};

const V20: &str = include_str!("../../../../tests/fixtures/released-upgrades/v20-lore-v0.15.0.sql");
const V13: &str = include_str!("../../../../tests/fixtures/released-upgrades/v13-lore-v0.2.0.sql");

fn build_v1(dir: &Path, fixture: &str) -> PathBuf {
    let path = dir.join("v1-lore.db");
    let connection = rusqlite::Connection::open(&path).expect("open v1");
    connection.execute_batch(fixture).expect("fixture schema");
    connection
        .execute_batch(
            "INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at, metadata_json, canonical_key) \
             VALUES ('mem-a', 'user_preference', 'Prefer UTC timestamps in persisted records.', 1.0, 'repo', 'acme/app', 'prefer,time', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '{\"source\":\"manual\"}', 'topic-a'); \
             INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at, metadata_json) \
             VALUES ('mem b/legacy', 'decision', 'Decision: use PostgreSQL notifications.', 0.9, 'repo', 'acme/app', '', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '{}'); \
             INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at, metadata_json) \
             VALUES ('mem-unscoped', 'note', 'No repository identity.', 1.0, 'repo', NULL, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}'); \
             INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at, metadata_json) \
             VALUES ('mem-bad-time', 'note', 'Broken timestamp.', 1.0, 'repo', 'acme/app', '', 'not a time', 'not a time', '{}'); \
             INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at, metadata_json) \
             VALUES ('mem-global', 'directive', 'Always run schema validation before copying rows.', 1.0, 'global', NULL, 'directive', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '{}'); \
             INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at, metadata_json, superseded_by) \
             VALUES ('mem-old', 'decision', 'Decision: use Redis for invalidation.', 0.8, 'repo', 'acme/app', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}', 'mem-a'); \
             INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at, metadata_json) \
             VALUES ('mem-suppressed', 'user_preference', 'Prefer compact release notes.', 1.0, 'repo', 'acme/app', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}');",
        )
        .expect("rows");
    // v20-only tables.
    let tables: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query");
        rows.collect::<Result<_, _>>().expect("collect")
    };
    if tables.iter().any(|name| name == "memory_suppression") {
        connection
            .execute_batch(
                "INSERT INTO memory_suppression (suppression_key, memory_id, canonical_fingerprint, scope, repository, actor, reason, created_at) \
                 VALUES ('sup-1', 'mem-suppressed', 'fingerprint-suppressed', 'repo', 'acme/app', 'user', 'forgotten', '2026-01-03T00:00:00.000Z');",
            )
            .expect("suppression");
    }
    if tables
        .iter()
        .any(|name| name == "repository_identity_mapping")
    {
        connection
            .execute_batch(
                "INSERT INTO repository_identity_mapping (legacy, canonical, created_at, updated_at) \
                 VALUES ('git@github.com:acme/app.git', 'github.com/acme/app', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');",
            )
            .expect("mapping");
    }
    drop(connection);
    path
}

fn config(dir: &Path) -> ResolvedConfig {
    ResolvedConfig {
        enabled: true,
        config_path: None,
        data_dir: dir.to_path_buf(),
        socket_path: dir.join("test.sock"),
        store_path: dir.join("lore-v2.db"),
        limits: Limits::default(),
        embedding_identity: None,
        embedding: None,
        sources: lore_core::config::ResolvedSources {
            roots: Vec::new(),
            sweep_seconds: 60,
            page_entries: 256,
            quantum_bytes: 4 * 1024 * 1024,
            max_record_bytes: 1024 * 1024,
        },
    }
}

#[test]
fn preview_creates_nothing_and_reports_accounting() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = build_v1(dir.path(), V20);
    let destination = dir.path().join("v2");
    let preview = migration::preview(&source, &destination).expect("preview");
    assert!(
        !destination.exists(),
        "preview must not create the destination"
    );
    assert_eq!(preview.schema_version, 20);
    assert_eq!(preview.importable_rows.get("semantic_memory"), Some(&7));
    assert_eq!(preview.importable_rows.get("memory_suppression"), Some(&1));
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    // Stable fingerprint across repeated previews.
    let again = migration::preview(&source, &destination).expect("preview again");
    assert_eq!(preview.fingerprint, again.fingerprint);
}

#[test]
fn apply_imports_with_dispositions_and_never_mutates_the_source() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = build_v1(dir.path(), V20);
    let before = std::fs::read(&source).expect("read source");
    let destination = dir.path().join("v2");
    let preview = migration::preview(&source, &destination).expect("preview");
    let status =
        migration::apply(&source, &destination, &preview.fingerprint, true, 1_000).expect("apply");
    assert_eq!(status.state, "validated");

    // Imported suppression state must be reflected in the metadata counters
    // that Status and the dashboard read.
    {
        // Activation publishes the staged store to the destination root.
        let published = destination.join("lore-v2.db");
        let store = Store::open_migration_store(&published).expect("open published store");
        let status = store.status().expect("status");
        let connection =
            rusqlite::Connection::open(&published).expect("open published store for counts");
        let actual_active: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("active count");
        let actual_forgotten: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE forgotten = 1",
                [],
                |row| row.get(0),
            )
            .expect("forgotten count");
        assert!(
            actual_forgotten > 0,
            "the fixture's suppression marks a memory forgotten"
        );
        assert_eq!(status.active_memories, actual_active);
        assert_eq!(status.forgotten_memories, actual_forgotten);
    }
    assert_eq!(status.counts.imported.get("semantic_memory"), Some(&5));
    assert!(
        status
            .counts
            .unresolved
            .keys()
            .any(|key| key.contains("unresolved_repository"))
    );
    assert!(
        status
            .counts
            .unresolved
            .keys()
            .any(|key| key.contains("invalid_created_at"))
    );
    assert_eq!(status.counts.imported.get("memory_suppression"), Some(&1));
    assert_eq!(
        status.counts.imported.get("repository_identity_mapping"),
        Some(&1)
    );
    assert!(status.counts.remapped_ids >= 1);

    let store_path = destination.join(migration::STAGING_STORE);
    let connection = rusqlite::Connection::open(&store_path).expect("open v2");
    let active: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(
        active, 3,
        "suppressed, unscoped, bad-time and superseded rows are not active"
    );
    let preserved: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE id = 'mem-a' AND authority = 'manual'",
            [],
            |row| row.get(0),
        )
        .expect("preserved");
    assert_eq!(
        preserved, 1,
        "valid ids and explicit authority are preserved"
    );
    let remapped: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE id LIKE 'mig_%'",
            [],
            |row| row.get(0),
        )
        .expect("remapped");
    assert_eq!(remapped, 1);
    // Supersession is remapped through the id map.
    let superseded_by: String = connection
        .query_row(
            "SELECT superseded_by FROM memories WHERE id = 'mem-old'",
            [],
            |row| row.get(0),
        )
        .expect("supersession");
    assert_eq!(superseded_by, "mem-a");
    // Suppression imported before eligibility: the suppressed row is not
    // active, and the suppression ledger carries its fingerprint.
    let suppressed_active: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE id = 'mem-suppressed' AND superseded_by IS NULL AND forgotten = 0",
            [],
            |row| row.get(0),
        )
        .expect("suppressed");
    assert_eq!(
        suppressed_active, 0,
        "v1 suppressions keep content ineligible"
    );
    let suppression: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM suppressions WHERE memory_id = 'mem-suppressed'",
            [],
            |row| row.get(0),
        )
        .expect("suppression row");
    assert_eq!(suppression, 1);
    let manifest: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM migration_manifest WHERE state = 'validated'",
            [],
            |row| row.get(0),
        )
        .expect("manifest");
    assert_eq!(manifest, 1);
    drop(connection);

    let after = std::fs::read(&source).expect("read source");
    assert_eq!(before, after, "the v1 source is never modified");
}

#[test]
fn stale_plans_and_changed_inputs_are_rejected() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = build_v1(dir.path(), V20);
    let destination = dir.path().join("v2");
    migration::preview(&source, &destination).expect("preview");
    let error =
        migration::apply(&source, &destination, "wrong-plan", true, 1_000).expect_err("stale");
    assert_eq!(error.reason, "MIGRATE_STALE_PLAN");

    // An input change invalidates the previous fingerprint.
    let preview = migration::preview(&source, &destination).expect("preview");
    let connection = rusqlite::Connection::open(&source).expect("open");
    connection
        .execute(
            "INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at, metadata_json) \
             VALUES ('mem-new', 'note', 'New evidence.', 1.0, 'repo', 'acme/app', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}')",
            [],
        )
        .expect("insert");
    drop(connection);
    let error = migration::apply(&source, &destination, &preview.fingerprint, true, 1_000)
        .expect_err("changed input");
    assert_eq!(error.reason, "MIGRATE_STALE_PLAN");
}

#[test]
fn unknown_populated_tables_block_apply() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = build_v1(dir.path(), V20);
    let connection = rusqlite::Connection::open(&source).expect("open");
    connection
        .execute_batch("CREATE TABLE mystery (id INTEGER); INSERT INTO mystery VALUES (1);")
        .expect("mystery");
    drop(connection);
    let destination = dir.path().join("v2");
    let preview = migration::preview(&source, &destination).expect("preview");
    assert!(!preview.blockers.is_empty());
    let error = migration::apply(&source, &destination, &preview.fingerprint, true, 1_000)
        .expect_err("blocked");
    assert_eq!(error.reason, "MIGRATE_BLOCKED");
    assert!(!destination.exists());
}

#[test]
fn resume_replays_idempotently_from_the_snapshot() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = build_v1(dir.path(), V20);
    let preview = migration::preview(&source, &dir.path().join("v2")).expect("preview");
    let destination = dir.path().join("v2");
    std::fs::create_dir_all(destination.join(migration::STAGING_DIR)).expect("staging");
    let staging = destination.join(migration::STAGING_DIR);
    let snapshot = staging.join(migration::SOURCE_SNAPSHOT);
    migration::snapshot_database(&source, &snapshot).expect("snapshot");
    let store =
        Store::open_migration_store(&staging.join(migration::STAGING_STORE)).expect("store");
    let run_id = "run-resume";
    store
        .begin_migration(
            run_id,
            20,
            &preview.fingerprint,
            &source.display().to_string(),
            1_000,
        )
        .expect("manifest");
    store
        .migration_import(&snapshot, run_id, 20, 1_000)
        .expect("first");
    let first = store.migration_counts().expect("counts");
    // Replaying the same snapshot neither duplicates nor skips rows.
    store
        .migration_import(&snapshot, run_id, 20, 1_100)
        .expect("second");
    let second = store.migration_counts().expect("counts");
    assert_eq!(first.imported, second.imported);
    assert_eq!(second.imported.get("semantic_memory"), Some(&5));
    drop(store);
    let stored: i64 = rusqlite::Connection::open(staging.join(migration::STAGING_STORE))
        .expect("open staging")
        .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
        .expect("count");
    assert_eq!(stored, 5, "replay does not duplicate memories");
    let status = migration::resume(&destination, run_id, 2_000).expect("resume");
    assert_eq!(status.run_id, run_id);
    assert_eq!(status.state, "validated");
}

#[test]
fn backup_and_restore_preserve_later_deletions() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config(dir.path());
    let store = Store::open(&config).expect("open");
    let retain = |key: &str, content: &str| RetainParams {
        idempotency_key: key.to_string(),
        kind: "note".to_string(),
        content: content.to_string(),
        scope: Scope::Global,
        repository: None,
        confidence: None,
        tags: Vec::new(),
        source_session_id: None,
        expires_at_ms: None,
    };
    let first = store
        .retain("client", &retain("k1", "First durable memory."), 1_000)
        .expect("retain");
    let second = store
        .retain("client", &retain("k2", "Second durable memory."), 1_100)
        .expect("retain");
    let snapshot = dir.path().join("backup.db");
    let manifest = backup::backup(&config.store_path, &snapshot, 2_000).expect("backup");
    assert_eq!(manifest.memories, 2);
    assert!(!manifest.checksum.is_empty());

    // Forget one memory after the snapshot; restoration must not resurrect it.
    store
        .forget(
            "client",
            &ForgetParams {
                idempotency_key: "f1".to_string(),
                memory_id: second.memory_id.clone(),
                reason: None,
            },
            2_100,
        )
        .expect("forget");
    drop(store);

    let preview = backup::restore_preview(&snapshot, &config.store_path).expect("preview");
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    assert_eq!(preview.snapshot_memories, 2);
    assert!(preview.current_suppressions >= 1);
    let error = backup::restore_apply(&snapshot, &config.store_path, "wrong", true, 2_200)
        .expect_err("stale plan");
    assert_eq!(error.reason, "RESTORE_STALE_PLAN");
    let report = backup::restore_apply(
        &snapshot,
        &config.store_path,
        &preview.plan_fingerprint,
        true,
        2_300,
    )
    .expect("restore");
    assert!(
        Path::new(&report.rescue).exists(),
        "rescue snapshot is preserved"
    );

    let restored = Store::open(&config).expect("reopen");
    let status = restored.status().expect("status");
    assert_eq!(
        status.active_memories, 1,
        "the later deletion survives restore"
    );
    let suppression: i64 = rusqlite::Connection::open(&config.store_path)
        .expect("open restored")
        .query_row("SELECT COUNT(*) FROM suppressions", [], |row| row.get(0))
        .expect("suppressions");
    assert!(suppression >= 1);
    assert_eq!(
        restored.migration_state().expect("state").as_deref(),
        None,
        "a normal store has no migration manifest"
    );
    let _ = first;
}

#[test]
fn v13_sources_import_from_the_older_marker_table() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = build_v1(dir.path(), V13);
    let destination = dir.path().join("v2");
    let preview = migration::preview(&source, &destination).expect("preview");
    assert_eq!(preview.schema_version, 13);
    assert_eq!(preview.importable_rows.get("semantic_memory"), Some(&7));
    let status =
        migration::apply(&source, &destination, &preview.fingerprint, true, 1_000).expect("apply");
    assert_eq!(status.counts.imported.get("semantic_memory"), Some(&5));
}

/// Cutover drill: the migrated store serves a full read/write round trip and
/// keeps v1 suppression in force. The source bytes stay untouched.
#[test]
fn cutover_drill_serves_round_trips_on_the_migrated_store() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = build_v1(dir.path(), V20);
    let source_before = std::fs::read(&source).expect("read source");
    let destination = dir.path().join("v2");
    let preview = migration::preview(&source, &destination).expect("preview");
    let status =
        migration::apply(&source, &destination, &preview.fingerprint, true, 1_000).expect("apply");
    assert_eq!(status.state, "validated");

    // Imported suppression state must be reflected in the metadata counters
    // that Status and the dashboard read.
    {
        let staged = destination.join(".lore-import/lore-v2.db");
        let store = Store::open_migration_store(&staged).expect("open staged store");
        let status = store.status().expect("status");
        let connection = rusqlite::Connection::open(&staged).expect("open staged store for counts");
        let actual_active: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("active count");
        let actual_forgotten: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE forgotten = 1",
                [],
                |row| row.get(0),
            )
            .expect("forgotten count");
        let suppression_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM suppressions", [], |row| row.get(0))
            .unwrap_or(-1);
        let active_suppressions: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM suppressions WHERE state = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(-1);
        eprintln!(
            "DIAG active={actual_active} forgotten={actual_forgotten} suppressions={suppression_rows} active_suppressions={active_suppressions}"
        );
        assert_eq!(status.active_memories, actual_active);
        assert_eq!(status.forgotten_memories, actual_forgotten);
    }

    // Activate the published store the way cutover does, then use it as the
    // daemon would: retain, recall, forget. The staging directory keeps the
    // immutable source snapshot for recovery.
    let staged = destination.join("lore-v2.db");
    assert!(staged.is_file(), "apply publishes the v2 store");
    assert!(
        destination
            .join(".lore-import/source-snapshot.db")
            .is_file()
    );
    let store = Store::open_migration_store(&staged).expect("open staged store");
    let now = 2_000_000i64;
    let retained = store
        .retain(
            "client-cutover",
            &RetainParams {
                idempotency_key: "cutover-1".to_string(),
                kind: "note".to_string(),
                content: "Cutover round-trip marker.".to_string(),
                scope: Scope::Global,
                repository: None,
                confidence: None,
                expires_at_ms: None,
                tags: Vec::new(),
                source_session_id: None,
            },
            now,
        )
        .expect("retain after cutover");

    let recalled = store
        .recall(
            &protocol::RecallParams {
                query: "Cutover round-trip marker".to_string(),
                repository: None,
                include_other_repositories: false,
                limit: Some(5),
                context_bytes: None,
            },
            now,
            5,
            4_096,
            None,
        )
        .expect("recall new content");
    assert!(
        recalled.context.contains("Cutover round-trip marker"),
        "{}",
        recalled.context
    );

    // v1-authored memories are searchable under their canonical repository.
    let canonical_repository: String = {
        let connection = rusqlite::Connection::open(&staged).expect("open staged for identity");
        connection
            .query_row(
                "SELECT repository FROM memories WHERE repository IS NOT NULL AND repository != '' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("migrated repository identity")
    };
    let legacy = store
        .recall(
            &protocol::RecallParams {
                query: "UTC timestamps persisted records".to_string(),
                repository: Some(canonical_repository.clone()),
                include_other_repositories: false,
                limit: Some(5),
                context_bytes: None,
            },
            now,
            5,
            4_096,
            None,
        )
        .expect("recall migrated content");
    assert!(legacy.context.contains("UTC"), "{}", legacy.context);

    // A v1 suppression still denies the suppressed proposition.
    let suppressed = store
        .recall(
            &protocol::RecallParams {
                query: "compact release notes".to_string(),
                repository: Some(canonical_repository.clone()),
                include_other_repositories: false,
                limit: Some(5),
                context_bytes: None,
            },
            now,
            5,
            4_096,
            None,
        )
        .expect("recall suppressed content");
    assert!(
        !suppressed.context.contains("compact release notes"),
        "{}",
        suppressed.context
    );

    // Forget round trip on the new store.
    store
        .forget(
            "client-cutover",
            &ForgetParams {
                idempotency_key: "cutover-2".to_string(),
                memory_id: retained.memory_id.clone(),
                reason: Some("drill".to_string()),
            },
            now,
        )
        .expect("forget");
    let after = store
        .recall(
            &protocol::RecallParams {
                query: "Cutover round-trip marker".to_string(),
                repository: None,
                include_other_repositories: false,
                limit: Some(5),
                context_bytes: None,
            },
            now,
            5,
            4_096,
            None,
        )
        .expect("recall after forget");
    assert!(
        !after.context.contains("Cutover round-trip marker"),
        "{}",
        after.context
    );

    let source_after = std::fs::read(&source).expect("re-read source");
    assert_eq!(
        source_before, source_after,
        "the v1 source is never mutated"
    );
}

/// The quarantined-set follow-up: repo-scoped rows with no repository import
/// as global only when asked, keep their suppression state, and re-running
/// changes nothing.
#[test]
fn unscoped_repo_rows_import_as_global_on_request() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = build_v1(dir.path(), V20);
    let destination = dir.path().join("v2");
    std::fs::create_dir_all(&destination).expect("destination");
    let config = config(&destination);
    let store = Store::open(&config).expect("open");

    // Add a transferable row with no repository: the schema cannot represent
    // that scope without one, so the explicit import lands it as global too.
    {
        let connection = rusqlite::Connection::open(&source).expect("open source");
        connection
            .execute_batch(
                "INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at, metadata_json) \
                 VALUES ('mem-transferable', 'directive', 'Applies to every project.', 1.0, 'transferable', NULL, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}');",
            )
            .expect("transferable row");
    }

    // The fixture has one repo-scoped row with no repository.
    let preview = store
        .import_unscoped_as_global(&source, false, 2_000)
        .expect("preview");
    assert_eq!(preview["found"], 2, "{preview}");
    assert_eq!(preview["apply"], false);
    assert_eq!(
        store
            .view_memories(None, None, None, None, false, None, 10)
            .expect("view")["items"]
            .as_array()
            .map(Vec::len),
        Some(0),
        "a preview must not write anything"
    );

    let applied = store
        .import_unscoped_as_global(&source, true, 2_000)
        .expect("apply");
    assert_eq!(applied["imported"], 2, "{applied}");
    assert_eq!(applied["scope"], "global");
    let transferable_scope: String = rusqlite::Connection::open(&config.store_path)
        .expect("open store")
        .query_row(
            "SELECT scope FROM memories WHERE kind = 'directive' AND content = 'Applies to every project.'",
            [],
            |row| row.get(0),
        )
        .expect("transferable row");
    assert_eq!(
        transferable_scope, "global",
        "a transferable row with no repository has no representable scope, so it lands as global"
    );

    // The row is now present as global scope with its content searchable.
    let connection = rusqlite::Connection::open(&config.store_path).expect("open store");
    let (scope, repository, forgotten): (String, Option<String>, i64) = connection
        .query_row(
            "SELECT scope, repository, forgotten FROM memories WHERE content LIKE 'No repository identity%'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("imported row");
    assert_eq!(scope, "global");
    assert_eq!(repository, None);
    assert_eq!(forgotten, 0);
    let fts: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM memory_fts WHERE content LIKE 'No repository identity%'",
            [],
            |row| row.get(0),
        )
        .expect("fts");
    assert_eq!(fts, 1, "imported rows are searchable");

    // Idempotent: a second apply imports nothing new.
    let again = store
        .import_unscoped_as_global(&source, true, 3_000)
        .expect("second apply");
    assert_eq!(again["imported"], 0, "{again}");
    assert_eq!(again["alreadyPresent"], 2, "{again}");
}
