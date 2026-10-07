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
