//! Preview/apply proofs for correction, purge and scope override.

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
        client_id: "test.rust.writeops".to_string(),
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
        json!({
            "idempotencyKey": key,
            "type": kind,
            "content": content,
            "scope": scope
        }),
        Some(store_id),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    body["result"]["memoryId"]
        .as_str()
        .expect("memory id")
        .to_string()
}

async fn recall_context(socket: &Path, store_id: &str, query: &str) -> String {
    let (code, body) = call(
        socket,
        "/v2/recall",
        json!({ "query": query, "limit": 10 }),
        Some(store_id),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    body["result"]["context"].as_str().unwrap_or("").to_string()
}

#[tokio::test]
async fn correction_previews_applies_and_retires_the_original() {
    let daemon = Daemon::start();
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    let store_id = status["storeId"].as_str().expect("store").to_string();
    let original = retain(
        &daemon.socket,
        &store_id,
        "wo-correct-1",
        "user_preference",
        "Prefer twenty second timeouts.",
        "global",
    )
    .await;

    let (code, preview) = call(
        &daemon.socket,
        "/v2/admin/correct",
        json!({
            "id": original,
            "content": "Prefer forty-five second timeouts because the upstream batch window is longer.",
            "action": "preview"
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{preview}");
    assert_eq!(preview["result"]["found"], true);
    let fingerprint = preview["result"]["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();

    let (code, stale) = call(
        &daemon.socket,
        "/v2/admin/correct",
        json!({
            "id": original,
            "content": "Different proposal entirely.",
            "action": "apply",
            "planFingerprint": fingerprint
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 412, "{stale}");
    assert_eq!(stale["error"]["reason"], "PREVIEW_STALE");

    let (code, applied) = call(
        &daemon.socket,
        "/v2/admin/correct",
        json!({
            "id": original,
            "content": "Prefer forty-five second timeouts because the upstream batch window is longer.",
            "action": "apply",
            "planFingerprint": fingerprint,
            "reason": "test correction"
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{applied}");
    let replacement = applied["result"]["memoryId"].as_str().expect("replacement");
    assert_ne!(replacement, original);
    assert!(
        applied["result"]["snapshot"]
            .as_str()
            .expect("snapshot")
            .ends_with(".db")
    );

    let context = recall_context(&daemon.socket, &store_id, "timeouts").await;
    assert!(context.contains("forty-five"), "{context}");
    assert!(!context.contains("twenty second"), "{context}");

    // The original is no longer active, so a fresh preview refuses.
    let (code, refused) = call(
        &daemon.socket,
        "/v2/admin/correct",
        json!({ "id": original, "content": "Again." }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 412, "{refused}");
    assert_eq!(refused["error"]["reason"], "MEMORY_NOT_ACTIVE");
}

#[tokio::test]
async fn purge_requires_a_plan_and_leaves_durable_suppression() {
    let daemon = Daemon::start();
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    let store_id = status["storeId"].as_str().expect("store").to_string();
    let first = retain(
        &daemon.socket,
        &store_id,
        "wo-purge-1",
        "note",
        "Purge me completely.",
        "global",
    )
    .await;
    let _second = retain(
        &daemon.socket,
        &store_id,
        "wo-purge-2",
        "note",
        "Keep me around.",
        "global",
    )
    .await;

    let (code, preview) = call(
        &daemon.socket,
        "/v2/admin/purge",
        json!({ "memoryIds": [first] }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{preview}");
    let fingerprint = preview["result"]["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();
    assert_eq!(preview["result"]["counts"]["memories"], 1);

    let (code, stale) = call(
        &daemon.socket,
        "/v2/admin/purge",
        json!({ "memoryIds": [first], "action": "apply", "planFingerprint": "nope" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 412, "{stale}");

    let (code, applied) = call(
        &daemon.socket,
        "/v2/admin/purge",
        json!({
            "memoryIds": [first],
            "action": "apply",
            "planFingerprint": fingerprint,
            "reason": "test purge"
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{applied}");
    assert_eq!(applied["result"]["purged"], 1);
    let run_id = applied["result"]["runId"]
        .as_str()
        .expect("run")
        .to_string();

    let context = recall_context(&daemon.socket, &store_id, "purge").await;
    assert!(!context.contains("Purge me"), "{context}");
    let context = recall_context(&daemon.socket, &store_id, "around").await;
    assert!(context.contains("Keep me around"), "{context}");

    let (code, run) = call(
        &daemon.socket,
        "/v2/admin/run-status",
        json!({ "runId": run_id }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{run}");
    assert_eq!(run["result"]["found"], true);
    assert_eq!(run["result"]["run"]["state"], "complete");
    assert_eq!(run["result"]["items"][0]["state"], "purged");

    // Selection is required.
    let (code, missing) = call(
        &daemon.socket,
        "/v2/admin/purge",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{missing}");
}

#[tokio::test]
async fn scope_override_applies_audits_and_clears() {
    let daemon = Daemon::start();
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    let store_id = status["storeId"].as_str().expect("store").to_string();
    let memory = retain(
        &daemon.socket,
        &store_id,
        "wo-scope-1",
        "note",
        "Scoped note that becomes global.",
        "global",
    )
    .await;

    let (code, preview) = call(
        &daemon.socket,
        "/v2/admin/scope-override",
        json!({
            "memoryIds": [memory],
            "scope": "repo",
            "repository": "acme/app",
            "actor": "tester",
            "reason": "belongs to one repository"
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{preview}");
    let fingerprint = preview["result"]["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();

    let (code, applied) = call(
        &daemon.socket,
        "/v2/admin/scope-override",
        json!({
            "memoryIds": [memory],
            "scope": "repo",
            "repository": "acme/app",
            "action": "apply",
            "planFingerprint": fingerprint,
            "actor": "tester",
            "reason": "belongs to one repository"
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{applied}");
    assert_eq!(applied["result"]["updated"], 1);

    let (code, audit) = call(
        &daemon.socket,
        "/v2/admin/scope-audit",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{audit}");
    assert_eq!(audit["result"]["entries"][0]["actor"], "tester");
    assert_eq!(audit["result"]["entries"][0]["scope"], "repo");

    // A scoped override without a repository is rejected before any write.
    let (code, invalid) = call(
        &daemon.socket,
        "/v2/admin/scope-override",
        json!({ "memoryIds": [memory], "scope": "repo" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{invalid}");
}
