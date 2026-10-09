//! Maintenance inventory: candidates, exact hygiene markers and rollback.

use std::path::Path;

use lore_core::config::{Limits, ResolvedConfig, ResolvedMaintenance, ResolvedSources};
use lore_core::store::Store;
use protocol::{RecallParams, RetainParams, Scope};

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

fn recall(store: &Store, query: &str, now: i64) -> String {
    store
        .recall(
            &RecallParams {
                query: query.to_string(),
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
        .expect("recall")
        .context
}

fn forgotten_flag(data_dir: &Path, memory_id: &str) -> i64 {
    let connection =
        rusqlite::Connection::open(data_dir.join("lore-v2.db")).expect("open for flag");
    connection
        .query_row(
            "SELECT forgotten FROM memories WHERE id = ?1",
            rusqlite::params![memory_id],
            |row| row.get(0),
        )
        .expect("flag")
}

fn marker_rows(data_dir: &Path) -> i64 {
    let connection =
        rusqlite::Connection::open(data_dir.join("lore-v2.db")).expect("open for markers");
    connection
        .query_row(
            "SELECT COUNT(*) FROM suppressions WHERE reason LIKE 'hygiene-auto:%'",
            [],
            |row| row.get(0),
        )
        .expect("markers")
}

fn retain(store: &Store, key: &str, content: &str, expires_at_ms: Option<i64>, now: i64) -> String {
    store
        .retain(
            "client-a",
            &RetainParams {
                idempotency_key: key.to_string(),
                kind: "note".to_string(),
                content: content.to_string(),
                scope: Scope::Global,
                repository: None,
                confidence: None,
                expires_at_ms,
                tags: Vec::new(),
                source_session_id: None,
            },
            now,
        )
        .expect("retain")
        .memory_id
}

#[test]
fn hygiene_reports_candidates_and_rolls_back_exactly() {
    let dir = tempfile::tempdir().expect("dir");
    let store = Store::open(&config(dir.path())).expect("open");
    let now = 2_000_000i64;
    let expired = retain(
        &store,
        "hyg-1",
        "Expired note body that must survive rollback.",
        Some(now - 1),
        now - 100,
    );
    let kept = retain(
        &store,
        "hyg-2",
        "Kept note body.",
        Some(now + 60_000),
        now - 100,
    );

    let candidates = store.hygiene_candidates(now, 10).expect("candidates");
    assert_eq!(candidates.len(), 1, "{candidates:?}");
    assert_eq!(candidates[0]["id"], expired);
    assert_ne!(candidates[0]["id"], kept);

    // Inventory defaults: hygiene is disabled, extraction and index upkeep on.
    let maintenance = ResolvedMaintenance::default();
    store
        .maintenance_sync(&maintenance, "global", now)
        .expect("sync");
    let tasks = store.maintenance_tasks("global").expect("tasks");
    assert_eq!(tasks.len(), 9);
    let by_name = |name: &str| tasks.iter().find(|task| task.task == name).expect("task");
    assert!(!by_name("memoryHygiene").enabled);
    assert!(by_name("deferredExtraction").enabled);
    assert!(by_name("indexUpkeep").enabled);
    assert!(!by_name("extractionRevalidation").enabled);
    assert_eq!(by_name("extractionRevalidation").cadence_seconds, 86_400);

    // A scheduled claim runs once; the second claim is refused while active.
    let run_id = store
        .maintenance_claim("memoryHygiene", "global", "manual", false, now)
        .expect("claim")
        .expect("claimed");
    assert!(
        store
            .maintenance_claim("memoryHygiene", "global", "manual", false, now)
            .expect("second claim")
            .is_none(),
        "one active claim per task and scope"
    );

    let marker = format!("hygiene-auto:{run_id}");
    let applied = store
        .hygiene_apply(&candidates, &marker, now)
        .expect("apply");
    assert_eq!(applied, 1);
    // Expiry hides the row from recall either way; the proof is the exact
    // forgotten/suppression marker lifecycle.
    assert_eq!(
        forgotten_flag(dir.path(), &expired),
        1,
        "apply marks the row"
    );
    assert_eq!(marker_rows(dir.path()), 1, "apply records its marker");
    assert!(recall(&store, "Kept note body", now).contains("Kept note body"));

    // The run records the exact marker and candidates for rollback.
    store
        .maintenance_finish(
            &run_id,
            "complete",
            applied as i64,
            0,
            0,
            Some(serde_json::json!({ "marker": marker, "applied": candidates })),
            now,
        )
        .expect("finish");

    // Content is preserved, not blanked, so rollback is byte-exact.
    let content: String = {
        let connection = rusqlite::Connection::open(config(dir.path()).store_path).expect("db");
        connection
            .query_row(
                "SELECT content FROM memories WHERE id = ?1",
                rusqlite::params![expired],
                |row| row.get(0),
            )
            .expect("content")
    };
    assert_eq!(content, "Expired note body that must survive rollback.");

    let restored = store.hygiene_rollback(&run_id).expect("rollback");
    assert_eq!(restored, 1);
    assert_eq!(
        forgotten_flag(dir.path(), &expired),
        0,
        "rollback un-forgets"
    );
    assert_eq!(marker_rows(dir.path()), 0, "rollback removes its marker");

    // The due time advanced by the cadence, so a sleeping daemon coalesces
    // missed intervals into one run on wake.
    let tasks = store.maintenance_tasks("global").expect("tasks");
    let hygiene = tasks
        .iter()
        .find(|task| task.task == "memoryHygiene")
        .expect("hygiene");
    assert_eq!(hygiene.runs, 1);
    assert!(hygiene.due_ms >= now + 60 * 1000);
}
