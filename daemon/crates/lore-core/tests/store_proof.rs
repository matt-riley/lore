//! Stage-2 store behaviour: policy, receipts, rollback, durability and scope.

use std::path::Path;
use std::time::{Duration, Instant};

use lore_core::config::{Limits, ResolvedConfig};
use lore_core::store::Store;
use protocol::{ForgetParams, RecallParams, RetainParams, Scope};

fn config_with(dir: &Path, limits: Limits) -> ResolvedConfig {
    ResolvedConfig {
        enabled: true,
        config_path: None,
        data_dir: dir.to_path_buf(),
        socket_path: dir.join("test.sock"),
        store_path: dir.join("lore-v2.db"),
        limits,
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

fn open(dir: &Path) -> Store {
    Store::open(&config_with(dir, Limits::default())).expect("open store")
}

fn retain(key: &str, content: &str, scope: Scope, repository: Option<&str>) -> RetainParams {
    RetainParams {
        idempotency_key: key.to_string(),
        kind: "note".to_string(),
        content: content.to_string(),
        scope,
        repository: repository.map(str::to_string),
        confidence: None,
        expires_at_ms: None,
        tags: Vec::new(),
        source_session_id: None,
    }
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

fn remember(store: &Store, key: &str, content: &str) -> String {
    store
        .retain(
            "client-a",
            &retain(key, content, Scope::Global, None),
            1_000,
        )
        .expect("retain")
        .memory_id
}

#[test]
fn retain_and_recall_round_trip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path());
    let result = store
        .retain(
            "client-a",
            &retain(
                "key-1",
                "The build uses pnpm workspaces.",
                Scope::Global,
                None,
            ),
            1_000,
        )
        .expect("retain");
    assert_eq!(result.write_result, "created");
    assert_eq!(result.embedding_status, "disabled");
    assert_eq!(result.committed_revision, "1");

    let recalled = store
        .recall(&recall("pnpm workspaces"), 2_000, 6, 8_192, None)
        .expect("recall");
    assert_eq!(recalled.records.len(), 1);
    assert_eq!(recalled.records[0].id, result.memory_id);
    assert_eq!(recalled.records[0].authority, "manual");
    assert_eq!(recalled.memory_revision, "1");
    assert_eq!(recalled.diagnostics.retrieval_mode, "lexical");
    assert_eq!(recalled.diagnostics.cache, "disabled");
    assert!(!recalled.context.is_empty());
}

#[test]
fn idempotent_retries_return_the_original_receipt() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path());
    let params = retain("key-1", "A durable fact.", Scope::Global, None);
    let first = store.retain("client-a", &params, 1_000).expect("first");
    let second = store.retain("client-a", &params, 2_000).expect("retry");
    assert_eq!(first.memory_id, second.memory_id);
    assert_eq!(first.committed_revision, second.committed_revision);
    assert_eq!(store.status().expect("status").active_memories, 1);

    let conflicting = retain("key-1", "Different content.", Scope::Global, None);
    let error = store
        .retain("client-a", &conflicting, 3_000)
        .expect_err("conflict");
    assert_eq!(error.reason, "IDEMPOTENCY_CONFLICT");

    // A different client may reuse the key independently.
    let other = retain("key-1", "Different content.", Scope::Global, None);
    assert!(store.retain("client-b", &other, 3_000).is_ok());
}

#[test]
fn forget_hides_the_memory_and_is_idempotent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path());
    let memory_id = remember(&store, "key-1", "Ephemeral content.");

    let forgotten = store
        .forget(
            "client-a",
            &ForgetParams {
                idempotency_key: "forget-1".to_string(),
                memory_id: memory_id.clone(),
                reason: Some("no longer needed".to_string()),
            },
            2_000,
        )
        .expect("forget");
    assert_eq!(forgotten.write_result, "forgotten");
    assert_eq!(forgotten.committed_revision, "2");
    assert!(
        store
            .recall(&recall("ephemeral"), 3_000, 6, 8_192, None)
            .expect("recall")
            .records
            .is_empty()
    );

    let repeat = store
        .forget(
            "client-a",
            &ForgetParams {
                idempotency_key: "forget-2".to_string(),
                memory_id: memory_id.clone(),
                reason: None,
            },
            3_000,
        )
        .expect("repeat forget");
    assert_eq!(repeat.write_result, "alreadyForgotten");
    assert_eq!(repeat.committed_revision, "2");
    assert_eq!(store.status().expect("status").memory_revision, 2);

    let unknown = store.forget(
        "client-a",
        &ForgetParams {
            idempotency_key: "forget-3".to_string(),
            memory_id: "00000000-0000-4000-8000-000000000001".to_string(),
            reason: None,
        },
        3_000,
    );
    assert_eq!(unknown.expect_err("unknown").reason, "MEMORY_NOT_FOUND");

    // The tombstone removed content, kept the fingerprint and reset counters.
    let independent = rusqlite::Connection::open(dir.path().join("lore-v2.db")).expect("open");
    let (forgotten_flag, content, hash): (i64, String, String) = independent
        .query_row(
            "SELECT forgotten, content, content_hash FROM memories WHERE id = ?1",
            [&memory_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("row");
    assert_eq!(forgotten_flag, 1);
    assert!(content.is_empty());
    assert_eq!(hash.len(), 64);
    let suppressions: i64 = independent
        .query_row("SELECT COUNT(*) FROM suppressions", [], |row| row.get(0))
        .expect("count");
    assert_eq!(suppressions, 1);
    let status = store.status().expect("status");
    assert_eq!(status.active_memories, 0);
    assert_eq!(status.forgotten_memories, 1);

    // The original Retain receipt still replays, but the memory stays hidden.
    let replay = store
        .retain(
            "client-a",
            &retain("key-1", "Ephemeral content.", Scope::Global, None),
            4_000,
        )
        .expect("replay");
    assert_eq!(replay.memory_id, memory_id);
    assert!(
        store
            .recall(&recall("ephemeral"), 4_000, 6, 8_192, None)
            .expect("recall")
            .records
            .is_empty()
    );
}

#[test]
fn scope_policy_blocks_foreign_repositories() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path());
    let global = remember(
        &store,
        "g",
        "shared repository detail across all repositories",
    );
    let repo_a = store
        .retain(
            "client-a",
            &retain(
                "a",
                "alpha repository detail",
                Scope::Repo,
                Some("github.com/team/a"),
            ),
            1_000,
        )
        .expect("retain a")
        .memory_id;
    let repo_b = store
        .retain(
            "client-a",
            &retain(
                "b",
                "beta repository detail",
                Scope::Repo,
                Some("github.com/team/b"),
            ),
            1_000,
        )
        .expect("retain b")
        .memory_id;
    let transfer_b = store
        .retain(
            "client-a",
            &retain(
                "tb",
                "beta transferable repository detail lesson",
                Scope::Transferable,
                Some("github.com/team/b"),
            ),
            1_000,
        )
        .expect("retain tb")
        .memory_id;

    let ids = |params: RecallParams, store: &Store| -> Vec<String> {
        store
            .recall(&params, 5_000, 20, 8_192, None)
            .expect("recall")
            .records
            .into_iter()
            .map(|record| record.id)
            .collect()
    };

    let mut query = recall("repository detail");
    let global_only = ids(
        RecallParams {
            repository: None,
            ..query.clone()
        },
        &store,
    );
    assert!(global_only.contains(&global));
    assert!(!global_only.contains(&repo_a));
    assert!(!global_only.contains(&repo_b));

    query.repository = Some("github.com/team/a".to_string());
    let local = ids(query.clone(), &store);
    assert!(local.contains(&global));
    assert!(local.contains(&repo_a));
    assert!(!local.contains(&repo_b));
    assert!(!local.contains(&transfer_b));

    let cross = ids(
        RecallParams {
            include_other_repositories: true,
            ..query.clone()
        },
        &store,
    );
    assert!(cross.contains(&transfer_b));
    assert!(!cross.contains(&repo_b));

    let transferable = ids(recall("transferable lesson"), &store);
    assert!(transferable.is_empty(), "transferable rows stay private");

    let mut cross_transferable = recall("transferable lesson");
    cross_transferable.repository = Some("github.com/team/a".to_string());
    cross_transferable.include_other_repositories = true;
    assert!(ids(cross_transferable, &store).contains(&transfer_b));
}

#[test]
fn expiry_at_exactly_now_is_ineligible() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path());
    let mut params = retain("expiring", "temporary guidance", Scope::Global, None);
    params.expires_at_ms = Some(1_000);
    store.retain("client-a", &params, 0).expect("retain");

    let at_expiry = store
        .recall(&recall("temporary"), 1_000, 6, 8_192, None)
        .expect("recall");
    assert!(at_expiry.records.is_empty(), "expiry is exclusive");

    let before_expiry = store
        .recall(&recall("temporary"), 999, 6, 8_192, None)
        .expect("recall");
    assert_eq!(before_expiry.records.len(), 1);

    let expired = store
        .recall(&recall("temporary"), 1_001, 6, 8_192, None)
        .expect("recall");
    assert!(expired.records.is_empty());
}

#[test]
fn failpoint_rolls_back_everything() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path());
    let params = retain("rollback", "should not survive", Scope::Global, None);
    let error = store
        .retain_with_failpoint("client-a", &params, 1_000, true)
        .expect_err("injected failure");
    assert_eq!(error.reason, "INJECTED_FAILURE");

    let status = store.status().expect("status");
    assert_eq!(status.active_memories, 0);
    assert_eq!(status.memory_revision, 0);
    assert_eq!(status.receipts, 0);
    assert!(
        store
            .recall(&recall("survive"), 2_000, 6, 8_192, None)
            .expect("recall")
            .records
            .is_empty()
    );

    let retried = store.retain("client-a", &params, 2_000).expect("retry");
    assert_eq!(retried.committed_revision, "1");
}

#[test]
fn fts_metacharacters_unicode_and_ties_are_safe() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path());
    let unicode = remember(&store, "u", "naïve café 東京 notes");
    remember(&store, "t1", "identical tie content");
    remember(&store, "t2", "identical tie content");

    for hostile in ["\"", "NEAR(", "OR *", "\"\"", "a\"b", "*", "AND OR NOT"] {
        assert!(
            store
                .recall(&recall(hostile), 5_000, 6, 8_192, None)
                .is_ok(),
            "hostile query must not error: {hostile}"
        );
    }

    let unicode_hits = store
        .recall(&recall("café 東京"), 5_000, 6, 8_192, None)
        .expect("recall");
    assert_eq!(unicode_hits.records.len(), 1);
    assert_eq!(unicode_hits.records[0].id, unicode);

    let first = store
        .recall(&recall("identical tie"), 5_000, 6, 8_192, None)
        .expect("recall");
    let second = store
        .recall(&recall("identical tie"), 5_001, 6, 8_192, None)
        .expect("recall");
    let ids: Vec<String> = first
        .records
        .iter()
        .map(|record| record.id.clone())
        .collect();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted, "ids break rank ties deterministically");
    assert_eq!(
        ids,
        second
            .records
            .iter()
            .map(|record| record.id.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn quota_rejects_new_memories() {
    let dir = tempfile::tempdir().expect("tempdir");
    let limits = Limits {
        max_memories: 1,
        ..Limits::default()
    };
    let store = Store::open(&config_with(dir.path(), limits)).expect("open");
    remember(&store, "one", "first memory");
    let error = store
        .retain(
            "client-a",
            &retain("two", "second memory", Scope::Global, None),
            1_000,
        )
        .expect_err("quota");
    assert_eq!(error.reason, "STORE_QUOTA");
    assert_eq!(error.http, 429);
}

#[test]
fn acknowledged_writes_survive_a_restart() {
    let dir = tempfile::tempdir().expect("tempdir");
    let memory_id;
    {
        let store = open(dir.path());
        let result = store
            .retain(
                "client-a",
                &retain(
                    "durable",
                    "acknowledged before restart",
                    Scope::Global,
                    None,
                ),
                1_000,
            )
            .expect("retain");
        memory_id = result.memory_id;
        assert_eq!(result.committed_revision, "1");
    }
    let reopened = open(dir.path());
    let recalled = reopened
        .recall(&recall("acknowledged"), 2_000, 6, 8_192, None)
        .expect("recall");
    assert_eq!(recalled.records.len(), 1);
    assert_eq!(recalled.records[0].id, memory_id);
    let replay = reopened
        .retain(
            "client-a",
            &retain(
                "durable",
                "acknowledged before restart",
                Scope::Global,
                None,
            ),
            3_000,
        )
        .expect("replay receipt");
    assert_eq!(replay.memory_id, memory_id);
    assert_eq!(reopened.status().expect("status").memory_revision, 1);
}

#[test]
fn expired_deadline_is_rejected_before_work() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path());
    remember(&store, "one", "some content");
    let past = Instant::now() - Duration::from_millis(1);
    let error = store
        .recall(&recall("some content"), 2_000, 6, 8_192, Some(past))
        .expect_err("deadline");
    assert_eq!(error.reason, "REQUEST_DEADLINE");
    assert_eq!(error.http, 504);
}

#[test]
fn response_context_budget_omits_whole_records() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = open(dir.path());
    remember(&store, "one", "first record content");
    remember(&store, "two", "second record content");
    let recalled = store
        .recall(&recall("record content"), 2_000, 6, 1, None)
        .expect("recall");
    assert_eq!(
        recalled.records.len(),
        2,
        "structured records stay complete"
    );
    assert!(recalled.context.is_empty(), "no partial context row fits");
    assert_eq!(recalled.sections[0].omitted, 2);
}

/// Regression: view requests must never take a second reader while holding
/// one. Two threads doing that on a two-connection pool deadlock each other
/// (each holds one reader and waits for the other's), which wedged the daemon
/// behind its blocking pool while the dashboard polled views.
#[test]
fn concurrent_views_do_not_deadlock_the_reader_pool() {
    use std::sync::Arc;
    use std::sync::mpsc;

    let dir = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(Store::open(&config_with(dir.path(), Limits::default())).expect("open"));
    let (sender, receiver) = mpsc::channel();
    let mut handles = Vec::new();
    for worker in 0..8 {
        let store = Arc::clone(&store);
        let sender = sender.clone();
        handles.push(std::thread::spawn(move || {
            for round in 0..25 {
                let result = if (worker + round) % 3 == 0 {
                    store.view_maintenance().map(|_| ())
                } else if (worker + round) % 3 == 1 {
                    store.view_overview(None).map(|_| ())
                } else {
                    store.view_filters().map(|_| ())
                };
                result.expect("view completes");
            }
            let _ = sender.send(worker);
        }));
    }
    drop(sender);
    let mut finished = 0;
    for _ in 0..8 {
        match receiver.recv_timeout(Duration::from_secs(20)) {
            Ok(_) => finished += 1,
            Err(_) => break,
        }
    }
    assert_eq!(
        finished, 8,
        "all view workers must finish; {finished}/8 completed before the deadline (deadlock on the reader pool)"
    );
    for handle in handles {
        handle.join().expect("join");
    }
}

/// Identical copies must not be rendered twice, and hygiene must be able to
/// retire the redundant rows reversibly.
#[test]
fn duplicate_content_is_collapsed_in_recall_and_retired_by_hygiene() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&config_with(dir.path(), Limits::default())).expect("open");

    let mut ids = Vec::new();
    for key in ["dup-1", "dup-2", "dup-3"] {
        let outcome = store
            .retain(
                "client-dupes",
                &RetainParams {
                    idempotency_key: key.to_string(),
                    kind: "user_preference".to_string(),
                    content: "Always run the schema check before copying rows.".to_string(),
                    scope: Scope::Global,
                    repository: None,
                    tags: Vec::new(),
                    confidence: None,
                    expires_at_ms: None,
                    source_session_id: None,
                },
                1_000,
            )
            .expect("retain");
        ids.push(outcome.memory_id);
    }

    // Recall returns one copy even though the store holds three.
    let params = RecallParams {
        query: "schema check".to_string(),
        repository: None,
        include_other_repositories: false,
        limit: None,
        context_bytes: None,
    };
    let context = store
        .recall(&params, 2_000, 20, 16 * 1024, None)
        .expect("recall");
    let same_line: Vec<&str> = context
        .context
        .lines()
        .filter(|line| line.contains("schema check"))
        .collect();
    assert_eq!(
        same_line.len(),
        1,
        "identical content renders once: {:?}",
        context.context
    );
    let returned: Vec<String> = context
        .records
        .iter()
        .filter(|record| record.content.contains("schema check"))
        .map(|record| record.id.clone())
        .collect();
    assert_eq!(returned.len(), 1, "one record per body: {returned:?}");

    // Hygiene reports the two redundant copies, keeps the oldest, and rolls back.
    let candidates = store.hygiene_candidates(3_000, 50).expect("candidates");
    let duplicates: Vec<&serde_json::Value> = candidates
        .iter()
        .filter(|candidate| candidate["reason"] == "duplicate")
        .collect();
    assert_eq!(duplicates.len(), 2, "{candidates:?}");
    let redundant = duplicates
        .iter()
        .filter_map(|candidate| candidate["id"].as_str())
        .collect::<Vec<_>>();
    // All three were retained in the same millisecond, so the tie-break is the
    // id: the smallest one survives and the other two are redundant.
    let survivor = ids.iter().min().expect("a smallest id").clone();
    assert!(
        !redundant.contains(&survivor.as_str()),
        "the tie-break keeper survives: {redundant:?}"
    );
    for id in &ids {
        if id != &survivor {
            assert!(
                redundant.contains(&id.as_str()),
                "{id} is redundant: {redundant:?}"
            );
        }
    }

    // A hygiene apply belongs to a claimed run so its marker can be rolled back.
    let run_id = store
        .maintenance_claim("memoryHygiene", "global", "manual", false, 3_500)
        .expect("claim")
        .expect("a free claim");
    let applied = store
        .hygiene_apply(&candidates, &format!("hygiene-auto:{run_id}"), 4_000)
        .expect("apply");
    assert_eq!(applied, 2);
    // The runner records the marker and the applied ids on the run, and that
    // record is what rollback replays.
    store
        .maintenance_finish(
            &run_id,
            "complete",
            applied as i64,
            0,
            0,
            Some(serde_json::json!({
                "marker": format!("hygiene-auto:{run_id}"),
                "applied": candidates,
            })),
            4_100,
        )
        .expect("finish");
    let connection =
        rusqlite::Connection::open(&config_with(dir.path(), Limits::default()).store_path)
            .expect("open store");
    let forgotten: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE content LIKE 'Always run the schema check%' AND forgotten = 1",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(forgotten, 2, "redundant copies are forgotten");

    let restored = store.hygiene_rollback(&run_id).expect("rollback");
    assert_eq!(restored, 2, "the exact marker rolls back both copies");
    let active: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE content LIKE 'Always run the schema check%' AND forgotten = 0",
            [],
            |row| row.get(0),
        )
        .expect("count after rollback");
    assert_eq!(active, 3);
}

#[cfg(unix)]
#[test]
fn store_files_are_owner_only_even_when_a_looser_file_already_exists() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("tempdir");
    // A store left behind with group/other access must be tightened on open.
    let database = dir.path().join("lore-v2.db");
    std::fs::write(&database, b"").expect("seed database file");
    std::fs::set_permissions(&database, std::fs::Permissions::from_mode(0o644))
        .expect("loosen seed file");

    let _store = open(dir.path());

    for name in ["lore-v2.db", "lore-v2.db-wal", "lore-v2.db-shm"] {
        let path = dir.path().join(name);
        let mode = std::fs::metadata(&path)
            .expect("store file exists")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{name} must be owner-only");
    }
}
