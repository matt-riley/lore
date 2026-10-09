//! Read-only administration operations: search, explain, validate, doctor and
//! the extraction audit.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use protocol::RequestMeta;
use serde_json::{Value, json};

struct Daemon {
    child: Child,
    socket: PathBuf,
    _dir: tempfile::TempDir,
}

impl Daemon {
    fn database_path(&self) -> PathBuf {
        self._dir.path().join("lore-v2.db")
    }

    fn start() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("lored.sock");
        let config_path = dir.path().join("lore.json");
        let config = json!({
            "configVersion": 2,
            "enabled": true,
            "dataDir": dir.path().to_str().expect("utf8"),
            "socketPath": socket.to_str().expect("utf8"),
        });
        std::fs::write(
            &config_path,
            serde_json::to_vec_pretty(&config).expect("config"),
        )
        .expect("write config");
        let child = Command::new(env!("CARGO_BIN_EXE_lored"))
            .arg("--config")
            .arg(&config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn lored");
        Self {
            child,
            socket,
            _dir: dir,
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn meta(store_id: Option<&str>) -> RequestMeta {
    RequestMeta {
        client_id: "test.rust.admin".to_string(),
        request_id: format!("request-{}", uuid::Uuid::new_v4()),
        session_id: None,
        expected_store_id: store_id.map(str::to_string),
        timeout_ms: None,
        required_capabilities: Vec::new(),
    }
}

async fn retain(
    socket: &Path,
    store_id: &str,
    key: &str,
    kind: &str,
    content: &str,
    scope: &str,
) -> String {
    let (code, body) = call(
        socket,
        "/v2/retain",
        json!({ "idempotencyKey": key, "type": kind, "content": content, "scope": scope }),
        Some(store_id),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    body["result"]["memoryId"]
        .as_str()
        .expect("memory id")
        .to_string()
}

async fn call(socket: &Path, route: &str, params: Value, store_id: Option<&str>) -> (u16, Value) {
    for _ in 0..500 {
        if let Ok(outcome) = lore::request(socket, route, meta(store_id), params.clone()).await {
            let body = serde_json::from_str::<Value>(&outcome.body).unwrap_or(Value::Null);
            return (outcome.status_code, body);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon never accepted requests");
}

#[tokio::test]
async fn admin_reads_report_search_explain_validate_doctor_and_audit() {
    let daemon = Daemon::start();
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    let store_id = status["storeId"].as_str().expect("store id").to_string();
    for capability in [
        "search.browse",
        "explain.context",
        "validate.read",
        "doctor.read",
        "audit.read",
    ] {
        assert!(
            status["result"]["capabilities"]
                .as_array()
                .expect("capabilities")
                .iter()
                .any(|value| value == capability),
            "missing {capability}: {status}"
        );
    }

    let retain = |key: &str, kind: &str, content: &str, scope: &str, repository: Option<&str>| {
        let mut meta = meta(Some(&store_id));
        meta.client_id = "test.rust.admin".to_string();
        json!({
            "idempotencyKey": key,
            "type": kind,
            "content": content,
            "scope": scope,
            "repository": repository,
        })
    };
    for params in [
        retain(
            "admin-1",
            "note",
            "Durable search target in the global scope.",
            "global",
            None,
        ),
        retain(
            "admin-2",
            "decision",
            "Durable search target for this repository.",
            "repo",
            Some("acme/app"),
        ),
        retain(
            "admin-3",
            "note",
            "Foreign repository search target.",
            "repo",
            Some("other/repo"),
        ),
    ] {
        let (code, body) = call(&daemon.socket, "/v2/retain", params, Some(&store_id)).await;
        assert_eq!(code, 200, "{body}");
    }

    // Scoped browsing sees global + the selected repository only.
    let (code, search) = call(
        &daemon.socket,
        "/v2/admin/search",
        json!({ "query": "durable search target", "repository": "acme/app", "limit": 20 }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{search}");
    let items = search["result"]["items"].as_array().expect("items");
    assert_eq!(items.len(), 2, "{search}");
    assert!(items.iter().all(|item| item["repository"] != "other/repo"));

    // Explicit administrative selection spans repositories.
    let (_, all) = call(
        &daemon.socket,
        "/v2/admin/search",
        json!({
            "query": "search target",
            "repository": "acme/app",
            "includeOtherRepositories": true,
            "limit": 20
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(
        all["result"]["items"].as_array().expect("items").len(),
        3,
        "{all}"
    );

    // Keyset pagination walks the same filtered set.
    let (_, first_page) = call(
        &daemon.socket,
        "/v2/admin/search",
        json!({ "query": "search target", "repository": "acme/app", "limit": 1 }),
        Some(&store_id),
    )
    .await;
    assert_eq!(
        first_page["result"]["items"]
            .as_array()
            .expect("items")
            .len(),
        1
    );
    let cursor = first_page["result"]["nextCursor"]
        .as_str()
        .expect("cursor")
        .to_string();
    let (_, second_page) = call(
        &daemon.socket,
        "/v2/admin/search",
        json!({ "query": "search target", "repository": "acme/app", "limit": 1, "cursor": cursor }),
        Some(&store_id),
    )
    .await;
    assert_ne!(
        first_page["result"]["items"][0]["id"],
        second_page["result"]["items"][0]["id"]
    );

    let (code, missing) = call(
        &daemon.socket,
        "/v2/admin/search",
        json!({ "repository": "acme/app" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{missing}");
    assert_eq!(missing["error"]["reason"], "ADMIN_ARGUMENT_INVALID");

    let (code, explain) = call(
        &daemon.socket,
        "/v2/admin/explain",
        json!({ "query": "durable search target", "repository": "acme/app" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{explain}");
    assert!(explain["result"]["sections"].is_array());
    assert!(explain["result"]["representedIds"].is_array());
    assert_eq!(explain["result"]["diagnostics"]["retrievalMode"], "lexical");

    let (code, validate) = call(
        &daemon.socket,
        "/v2/admin/validate",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{validate}");
    assert_eq!(validate["result"]["ok"], true, "{validate}");
    assert_eq!(validate["result"]["schemaVersion"], 8);
    assert_eq!(validate["result"]["foreignKeyViolations"], 0);

    let (code, doctor) = call(
        &daemon.socket,
        "/v2/admin/doctor",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{doctor}");
    assert!(doctor["result"]["hints"].is_array());
    assert_eq!(doctor["result"]["sources"]["total"], 0);

    let (code, audit) = call(
        &daemon.socket,
        "/v2/admin/audit/extractions",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{audit}");
    assert!(audit["result"]["sources"].is_array());
    assert_eq!(audit["result"]["gaps"]["sourcesWithSkippedRecords"], 0);

    let (code, unknown) = call(
        &daemon.socket,
        "/v2/admin/not-an-op",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 501, "{unknown}");
}
#[tokio::test]
async fn repair_reports_typed_candidates_and_respects_selection() {
    let daemon = Daemon::start();
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    let store_id = status["storeId"].as_str().expect("store").to_string();
    let memory = retain(
        &daemon.socket,
        &store_id,
        "admin-repair-typed",
        "note",
        "Repair candidate content.",
        "global",
    )
    .await;

    // Remove the FTS row to create a typed candidate.
    {
        let connection = rusqlite::Connection::open(daemon.database_path()).expect("open db");
        connection
            .execute(
                "DELETE FROM memory_fts WHERE memory_id = ?1",
                rusqlite::params![memory],
            )
            .expect("delete fts row");
    }

    let (code, preview) = call(
        &daemon.socket,
        "/v2/admin/repair",
        json!({ "sourceLimitBytes": 1024 * 1024 }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{preview}");
    let candidates = preview["result"]["candidates"]
        .as_array()
        .expect("candidates");
    assert_eq!(candidates.len(), 1, "{preview}");
    assert_eq!(candidates[0]["type"], "fts_gap");
    assert_eq!(candidates[0]["id"], format!("fts_gap:{memory}"));
    assert_eq!(preview["result"]["sourceLimitExceeded"], false);
    let fingerprint = preview["result"]["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();

    // A selection naming an unknown candidate is refused before any write.
    let (code, unknown) = call(
        &daemon.socket,
        "/v2/admin/repair",
        json!({
            "action": "apply",
            "planFingerprint": fingerprint,
            "sourceLimitBytes": 1024 * 1024,
            "selectedCandidateIds": ["fts_gap:does-not-exist"]
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{unknown}");
    assert_eq!(unknown["error"]["reason"], "CANDIDATE_NOT_FOUND");

    // Selecting exactly the real candidate repairs only it.
    let (code, applied) = call(
        &daemon.socket,
        "/v2/admin/repair",
        json!({
            "action": "apply",
            "planFingerprint": fingerprint,
            "sourceLimitBytes": 1024 * 1024,
            "selectedCandidateIds": [format!("fts_gap:{memory}")],
            "actor": "tester"
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{applied}");
    assert_eq!(applied["result"]["state"], "complete");
    assert_eq!(applied["result"]["counts"]["ftsRebuilt"], 1);
    assert_eq!(applied["result"]["counts"]["selected"], 1);
    assert!(
        applied["result"]["unresolved"]
            .as_array()
            .expect("u")
            .is_empty()
    );

    let (code, after) = call(
        &daemon.socket,
        "/v2/admin/repair",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{after}");
    assert_eq!(after["result"]["repairable"], 0);

    // Observed source bytes above the caller's limit refuse complete-source
    // work before anything is written.
    {
        let connection = rusqlite::Connection::open(daemon.database_path()).expect("open db");
        connection
            .execute(
                "INSERT INTO sources (source_id, client, root_id, native_session_id, canonical_path, \
                 repository, repository_verified, generation, generation_seq, state, observed_size, \
                 offset, prefix_hash, boundary_hash, parser_version, skipped_records, pending_bytes, \
                 parser_state, last_progress_ms, last_error, created_ms, updated_ms) \
                 VALUES ('src-limit', 'pi', 'root', 's-limit', '/tmp/limit.jsonl', NULL, 0, \
                 'gen-1', 1, 'caught_up', 4096, 0, NULL, NULL, 'pi-v1', 0, 0, NULL, ?1, NULL, ?1, ?1)",
                rusqlite::params![1_000i64],
            )
            .expect("seed source");
    }
    let (code, limited_preview) = call(
        &daemon.socket,
        "/v2/admin/repair",
        json!({ "action": "preview", "sourceLimitBytes": 16 }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{limited_preview}");
    assert_eq!(limited_preview["result"]["sourceLimitExceeded"], true);
    let limited_plan = limited_preview["result"]["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();
    let (code, limited) = call(
        &daemon.socket,
        "/v2/admin/repair",
        json!({ "action": "apply", "planFingerprint": limited_plan, "sourceLimitBytes": 16 }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{limited}");
    assert_eq!(limited["error"]["reason"], "SOURCE_LIMIT_EXCEEDED");
}

#[tokio::test]
async fn audit_report_stays_read_only_and_markers_apply_and_roll_back() {
    let daemon = Daemon::start();
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    let store_id = status["storeId"].as_str().expect("store").to_string();

    let (code, report) = call(
        &daemon.socket,
        "/v2/admin/audit/extractions",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{report}");
    assert!(
        report["result"]["revalidations"]
            .as_array()
            .expect("r")
            .is_empty()
    );

    // Applying a marker needs a real extraction run.
    let (code, missing) = call(
        &daemon.socket,
        "/v2/admin/audit/extractions",
        json!({ "action": "apply", "runId": "nope" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 404, "{missing}");
    assert_eq!(missing["error"]["reason"], "REVALIDATION_TARGET_NOT_FOUND");

    let (code, rollback_missing) = call(
        &daemon.socket,
        "/v2/admin/audit/extractions",
        json!({ "action": "rollback", "runId": "nope" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 404, "{rollback_missing}");
    assert_eq!(
        rollback_missing["error"]["reason"],
        "REVALIDATION_MARKER_NOT_FOUND"
    );

    let (code, unknown_action) = call(
        &daemon.socket,
        "/v2/admin/audit/extractions",
        json!({ "action": "delete" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{unknown_action}");
}

#[tokio::test]
async fn doctor_reports_install_health_without_mutating() {
    let daemon = Daemon::start();
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    let store_id = status["storeId"].as_str().expect("store").to_string();
    let (code, doctor) = call(
        &daemon.socket,
        "/v2/admin/doctor",
        json!({ "dryRun": true, "limit": 10 }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{doctor}");
    let result = &doctor["result"];
    assert_eq!(result["dryRun"], true);
    assert!(result["installHealth"].is_object());
    assert!(result["installHealth"]["node"]["found"].is_boolean());
    assert!(result["trajectoryArtifacts"].as_array().expect("t").len() <= 10);
    assert!(result["plannedActions"].as_array().is_some());
    assert!(result["healthReasons"].as_array().is_some());
    assert!(result["sourceCases"].as_array().is_some());
    // Doctor is observe-only: nothing in the store changed.
    let (_, after) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    assert_eq!(
        after["result"]["memoryRevision"],
        status["result"]["memoryRevision"]
    );
}
