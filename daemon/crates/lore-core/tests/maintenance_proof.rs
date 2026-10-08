//! Maintenance tasks: expiry really forgets and leaves durable suppression.

use std::path::Path;

use lore_core::config::{Limits, ResolvedConfig, ResolvedSources};
use lore_core::store::Store;
use protocol::{RecallParams, RetainParams, Scope};

fn forgotten_flag(data_dir: &Path, memory_id: &str) -> i64 {
    let connection =
        rusqlite::Connection::open(data_dir.join("lore-v2.db")).expect("open for forgotten flag");
    connection
        .query_row(
            "SELECT forgotten FROM memories WHERE id = ?1",
            rusqlite::params![memory_id],
            |row| row.get(0),
        )
        .expect("forgotten flag")
}

fn recall(query: &str) -> RecallParams {
    RecallParams {
        query: query.to_string(),
        repository: None,
        include_other_repositories: false,
        limit: None,
        context_bytes: None,
    }
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
        sources: ResolvedSources {
            roots: Vec::new(),
            sweep_seconds: 60,
            page_entries: 256,
            quantum_bytes: 4 * 1024 * 1024,
            max_record_bytes: 1024 * 1024,
        },
    }
}

#[test]
fn maintenance_expires_due_memories_and_records_a_run() {
    let dir = tempfile::tempdir().expect("dir");
    let store = Store::open(&config(dir.path())).expect("open");
    let now = 1_000_000i64;
    let expired = store
        .retain(
            "client-a",
            &RetainParams {
                idempotency_key: "maint-expired".to_string(),
                kind: "note".to_string(),
                content: "Expired note body.".to_string(),
                scope: Scope::Global,
                repository: None,
                confidence: None,
                expires_at_ms: Some(now - 1),
                tags: Vec::new(),
                source_session_id: None,
            },
            now - 100,
        )
        .expect("retain expired");
    let kept = store
        .retain(
            "client-a",
            &RetainParams {
                idempotency_key: "maint-kept".to_string(),
                kind: "note".to_string(),
                content: "Kept note body.".to_string(),
                scope: Scope::Global,
                repository: None,
                confidence: None,
                expires_at_ms: Some(now + 60_000),
                tags: Vec::new(),
                source_session_id: None,
            },
            now - 100,
        )
        .expect("retain kept");

    // Dry run reports the due row but changes nothing.
    let dry = store
        .maintenance_run(&["expire_memories".to_string()], true, now)
        .expect("dry run");
    assert!(dry.dry_run);
    assert_eq!(dry.tasks[0].affected, 1);
    assert!(dry.run_id.is_none());
    assert_eq!(
        forgotten_flag(dir.path(), &expired.memory_id),
        0,
        "dry run must not forget"
    );

    let applied = store
        .maintenance_run(&["expire_memories".to_string()], false, now)
        .expect("apply");
    assert_eq!(applied.tasks[0].affected, 1);
    let run_id = applied.run_id.expect("run recorded");
    let run = store.run_status(&run_id, None, 10).expect("run status");
    assert_eq!(run["found"], true);
    assert_eq!(run["run"]["state"], "complete");

    assert_eq!(
        forgotten_flag(dir.path(), &expired.memory_id),
        1,
        "apply must forget"
    );
    let context = store
        .recall(&recall("Kept note"), now, 5, 4_096, None)
        .expect("recall kept");
    assert!(
        context.context.contains("Kept note body"),
        "{}",
        context.context
    );

    // The expiry is durably suppressed: re-retaining the same content cannot
    // resurrect it through extraction suppression checks.
    let suppressions: i64 = {
        let connection =
            rusqlite::Connection::open(&config(dir.path()).store_path).expect("open for count");
        connection
            .query_row(
                "SELECT COUNT(*) FROM suppressions WHERE memory_id = ?1 AND reason = 'expired'",
                rusqlite::params![expired.memory_id],
                |row| row.get(0),
            )
            .expect("suppression count")
    };
    assert_eq!(suppressions, 1);
    let kept_id = kept.memory_id;
    assert_ne!(expired.memory_id, kept_id);
}
