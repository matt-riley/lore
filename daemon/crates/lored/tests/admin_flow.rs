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
    assert_eq!(validate["result"]["schemaVersion"], 5);
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
