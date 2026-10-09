//! Embedding intent/job/vector lifecycle: reconciliation, lease fencing,
//! retries, obsolescence and eligibility.

use std::path::Path;

use lore_core::config::{Limits, ResolvedConfig};
use lore_core::store::{CompleteOutcome, FailOutcome, SemanticInput, Store};
use protocol::{ForgetParams, RecallParams, RetainParams, Scope};

const IDENTITY: &str = "test:model:g0:d4:utf8-v1";

fn config(dir: &Path) -> ResolvedConfig {
    ResolvedConfig {
        enabled: true,
        config_path: None,
        data_dir: dir.to_path_buf(),
        socket_path: dir.join("test.sock"),
        store_path: dir.join("lore-v2.db"),
        limits: Limits::default(),
        embedding_identity: Some(IDENTITY.to_string()),
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

fn retain(key: &str, content: &str) -> RetainParams {
    RetainParams {
        idempotency_key: key.to_string(),
        kind: "note".to_string(),
        content: content.to_string(),
        scope: Scope::Global,
        repository: None,
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

#[test]
fn intents_jobs_vectors_and_coverage_round_trip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&config(dir.path())).expect("open");
    let memory_id = store
        .retain(
            "client",
            &retain("k1", "a fact only a vector can find"),
            1_000,
        )
        .expect("retain")
        .memory_id;

    let counts = store.embedding_counts(IDENTITY, 1_000).expect("counts");
    assert_eq!(counts.pending, 1);
    assert_eq!(counts.current_vectors, 0);
    assert_eq!(counts.eligible_memories, 1);

    let page = store
        .reconcile_page(IDENTITY, None, 256, 1_000)
        .expect("reconcile");
    assert_eq!(page.queued, 1);
    assert!(page.next_cursor.is_none());

    let job = store
        .claim_job("owner-a", 1_000, 60_000)
        .expect("claim")
        .expect("job present");
    assert_eq!(job.memory_id, memory_id);
    assert_eq!(job.attempts, 1);

    let outcome = store
        .complete_job(
            &job.job_id,
            &job.lease_token,
            "owner-a",
            &[1.0, 0.0, 0.0, 0.0],
            1_100,
        )
        .expect("complete");
    assert_eq!(outcome, CompleteOutcome::Stored);

    let counts = store.embedding_counts(IDENTITY, 1_100).expect("counts");
    assert_eq!(counts.current_vectors, 1);
    assert_eq!(counts.pending, 0);

    let query = [1.0f32, 0.0, 0.0, 0.0];
    let semantic = SemanticInput {
        identity: IDENTITY,
        vector: Some(&query),
        min_similarity: 0.5,
        fallback_reason: None,
        cache_state: "miss",
    };
    let result = store
        .recall_fused(
            &recall("unrelated lexical probe"),
            1_200,
            6,
            8_192,
            None,
            semantic,
            None,
        )
        .expect("recall");
    assert_eq!(result.records.len(), 1);
    assert_eq!(result.records[0].id, memory_id);
    assert_eq!(result.diagnostics.retrieval_mode, "hybrid");
    assert_eq!(result.diagnostics.vector_contribution, 1);
    assert_eq!(result.diagnostics.fallback_reason, "NONE");
}

#[test]
fn lease_fencing_rejects_stale_completion() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&config(dir.path())).expect("open");
    store
        .retain("client", &retain("k1", "lease fenced fact"), 1_000)
        .expect("retain");
    store
        .reconcile_page(IDENTITY, None, 256, 1_000)
        .expect("reconcile");

    let first = store
        .claim_job("owner-a", 1_000, 5_000)
        .expect("claim")
        .expect("job");
    let reaped = store.reap_expired_jobs(10_000).expect("reap");
    assert!(reaped >= 1);

    let second = store
        .claim_job("owner-b", 10_000, 60_000)
        .expect("claim")
        .expect("job");
    assert_ne!(first.lease_token, second.lease_token);

    let stale = store
        .complete_job(
            &first.job_id,
            &first.lease_token,
            "owner-a",
            &[1.0, 0.0, 0.0, 0.0],
            10_100,
        )
        .expect("stale complete");
    assert_eq!(stale, CompleteOutcome::Obsolete);

    let fresh = store
        .complete_job(
            &second.job_id,
            &second.lease_token,
            "owner-b",
            &[1.0, 0.0, 0.0, 0.0],
            10_200,
        )
        .expect("fresh complete");
    assert_eq!(fresh, CompleteOutcome::Stored);
    assert_eq!(
        store
            .embedding_counts(IDENTITY, 10_300)
            .expect("counts")
            .current_vectors,
        1
    );
}

#[test]
fn forgetting_obsoletes_jobs_and_removes_vectors() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&config(dir.path())).expect("open");
    let memory_id = store
        .retain("client", &retain("k1", "ephemeral vector fact"), 1_000)
        .expect("retain")
        .memory_id;
    store
        .reconcile_page(IDENTITY, None, 256, 1_000)
        .expect("reconcile");
    let job = store
        .claim_job("owner", 1_000, 60_000)
        .expect("claim")
        .expect("job");

    store
        .forget(
            "client",
            &ForgetParams {
                idempotency_key: "f1".to_string(),
                memory_id: memory_id.clone(),
                reason: None,
            },
            2_000,
        )
        .expect("forget");

    let stale = store
        .complete_job(
            &job.job_id,
            &job.lease_token,
            "owner",
            &[1.0, 0.0, 0.0, 0.0],
            2_100,
        )
        .expect("complete after forget");
    assert_eq!(stale, CompleteOutcome::Obsolete);
    let counts = store.embedding_counts(IDENTITY, 2_200).expect("counts");
    assert_eq!(counts.current_vectors, 0);
    assert_eq!(counts.pending, 0);
}

#[test]
fn retries_exhaust_then_explicit_retry_resets() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&config(dir.path())).expect("open");
    store
        .retain("client", &retain("k1", "retry budget fact"), 1_000)
        .expect("retain");
    store
        .reconcile_page(IDENTITY, None, 256, 1_000)
        .expect("reconcile");

    let mut outcome = FailOutcome::RetryScheduled;
    for attempt in 0..5 {
        let job = store
            .claim_job("owner", 1_000, 60_000)
            .expect("claim")
            .expect("job");
        assert_eq!(job.attempts, attempt + 1);
        outcome = store
            .fail_job(
                &job.job_id,
                &job.lease_token,
                "owner",
                "PROVIDER_OFFLINE",
                true,
                Some(0),
                1_000,
            )
            .expect("fail");
    }
    assert_eq!(outcome, FailOutcome::Terminal);
    assert!(
        store
            .claim_job("owner", 1_000, 60_000)
            .expect("claim")
            .is_none(),
        "terminal failures are not claimed"
    );
    let counts = store.embedding_counts(IDENTITY, 1_000).expect("counts");
    assert_eq!(counts.failed, 1);

    let reset = store
        .retry_failed_jobs(Some(IDENTITY), None, 2_000)
        .expect("retry");
    assert_eq!(reset, 1);
    assert!(
        store
            .claim_job("owner", 2_000, 60_000)
            .expect("claim")
            .is_some(),
        "explicit retry makes the job claimable again"
    );
}

#[test]
fn reconciliation_is_bounded_and_idempotent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&config(dir.path())).expect("open");
    store
        .retain("client", &retain("k1", "first reconciliation fact"), 1_000)
        .expect("retain");
    store
        .retain("client", &retain("k2", "second reconciliation fact"), 1_000)
        .expect("retain");

    let page_one = store
        .reconcile_page(IDENTITY, None, 1, 1_000)
        .expect("page one");
    assert_eq!(page_one.queued, 1);
    assert!(page_one.next_cursor.is_some());

    let page_two = store
        .reconcile_page(IDENTITY, page_one.next_cursor.as_deref(), 1, 1_000)
        .expect("page two");
    assert_eq!(page_two.queued, 1);
    assert!(page_two.next_cursor.is_some());
    assert_ne!(page_one.next_cursor, page_two.next_cursor);

    let page_three = store
        .reconcile_page(IDENTITY, page_two.next_cursor.as_deref(), 1, 1_000)
        .expect("page three");
    assert_eq!(page_three.queued, 0);
    assert!(
        page_three.next_cursor.is_none(),
        "the cursor wraps at the end"
    );

    let again = store
        .reconcile_page(IDENTITY, None, 256, 1_000)
        .expect("repeat");
    assert_eq!(again.queued, 0, "materialized jobs are not duplicated");
    assert_eq!(
        store
            .embedding_counts(IDENTITY, 1_000)
            .expect("counts")
            .queued,
        2
    );
}

#[test]
fn vector_pages_respect_scope_isolation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&config(dir.path())).expect("open");
    let global = store
        .retain("client", &retain("g", "global vector fact"), 1_000)
        .expect("retain")
        .memory_id;
    let mut repo_a = retain("a", "alpha vector fact");
    repo_a.scope = Scope::Repo;
    repo_a.repository = Some("github.com/team/a".to_string());
    let repo_a_id = store
        .retain("client", &repo_a, 1_000)
        .expect("retain a")
        .memory_id;
    let mut repo_b = retain("b", "beta vector fact");
    repo_b.scope = Scope::Transferable;
    repo_b.repository = Some("github.com/team/b".to_string());
    let repo_b_id = store
        .retain("client", &repo_b, 1_000)
        .expect("retain b")
        .memory_id;

    store
        .reconcile_page(IDENTITY, None, 256, 1_000)
        .expect("reconcile");
    for _ in 0..3 {
        let job = store
            .claim_job("owner", 1_000, 60_000)
            .expect("claim")
            .expect("job");
        store
            .complete_job(
                &job.job_id,
                &job.lease_token,
                "owner",
                &[1.0, 0.0, 0.0, 0.0],
                1_100,
            )
            .expect("complete");
    }
    let connection = rusqlite::Connection::open(dir.path().join("lore-v2.db")).expect("open");
    let page = store
        .vector_page(
            &connection,
            IDENTITY,
            None,
            100,
            Some("github.com/team/a"),
            false,
            2_000,
        )
        .expect("page");
    let ids: Vec<&str> = page
        .iter()
        .map(|stored| stored.memory_id.as_str())
        .collect();
    assert!(ids.contains(&global.as_str()));
    assert!(ids.contains(&repo_a_id.as_str()));
    assert!(!ids.contains(&repo_b_id.as_str()));

    let cross = store
        .vector_page(
            &connection,
            IDENTITY,
            None,
            100,
            Some("github.com/team/a"),
            true,
            2_000,
        )
        .expect("cross page");
    assert!(
        cross.iter().any(|stored| stored.memory_id == repo_b_id),
        "foreign transferable rows appear only with explicit consent"
    );
}

#[test]
fn schema_reports_current_version_after_migration() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&config(dir.path())).expect("open");
    let status = store.status().expect("status");
    assert_eq!(status.schema_version, 9);
    let connection = rusqlite::Connection::open(dir.path().join("lore-v2.db")).expect("open");
    let jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='embedding_jobs'",
            [],
            |row| row.get(0),
        )
        .expect("jobs table");
    assert_eq!(jobs, 1);
}
