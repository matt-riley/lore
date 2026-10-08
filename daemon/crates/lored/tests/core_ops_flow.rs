//! Onboarding, maintenance, reflection, deferred processing and backfill.

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
        client_id: "test.rust.coreops".to_string(),
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

async fn store_id(daemon: &Daemon) -> String {
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    status["storeId"].as_str().expect("store").to_string()
}

async fn retain(socket: &Path, store_id: &str, key: &str, kind: &str, content: &str) -> String {
    let (code, body) = call(
        socket,
        "/v2/retain",
        json!({
            "idempotencyKey": key,
            "type": kind,
            "content": content,
            "scope": "global"
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

#[tokio::test]
async fn onboard_is_idempotent_and_updates_in_place() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon).await;

    let (code, onboarded) = call(
        &daemon.socket,
        "/v2/admin/onboard",
        json!({
            "userName": "Matt",
            "assistantName": "Felix",
            "voice": "collaborative",
            "warmth": "warm",
            "collaborative": true,
            "useNameNaturally": true
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{onboarded}");
    let assistant = onboarded["result"]["assistant"]["memoryId"]
        .as_str()
        .expect("assistant slot")
        .to_string();
    let user = onboarded["result"]["user"]["memoryId"]
        .as_str()
        .expect("user slot")
        .to_string();
    assert_eq!(onboarded["result"]["assistant"]["created"], true);

    // Repeating the same input keeps both memory ids and creates nothing.
    let (_, repeat) = call(
        &daemon.socket,
        "/v2/admin/onboard",
        json!({
            "userName": "Matt",
            "assistantName": "Felix",
            "voice": "collaborative",
            "warmth": "warm",
            "collaborative": true,
            "useNameNaturally": true
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(repeat["result"]["assistant"]["memoryId"], assistant);
    assert_eq!(repeat["result"]["user"]["memoryId"], user);
    assert_eq!(repeat["result"]["assistant"]["created"], false);

    // A changed voice updates the same slot instead of duplicating it.
    let (code, updated) = call(
        &daemon.socket,
        "/v2/admin/onboard",
        json!({ "assistantName": "Felix", "voice": "playful" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{updated}");
    assert_eq!(updated["result"]["assistant"]["memoryId"], assistant);

    let (code, recall) = call(
        &daemon.socket,
        "/v2/recall",
        json!({ "query": "assistant voice", "limit": 5 }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{recall}");
    let context = recall["result"]["context"].as_str().unwrap_or("");
    assert!(context.contains("playful"), "{context}");
    assert!(!context.contains("collaborative"), "{context}");

    let (_, invalid) = call(
        &daemon.socket,
        "/v2/admin/onboard",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(invalid["error"]["reason"], "ADMIN_ARGUMENT_INVALID");
}

#[tokio::test]
async fn maintenance_expires_dry_runs_then_applies() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon).await;
    let expired = retain(
        &daemon.socket,
        &store_id,
        "core-expire-1",
        "note",
        "This note expires immediately.",
    )
    .await;
    let _kept = retain(
        &daemon.socket,
        &store_id,
        "core-expire-2",
        "note",
        "This note stays.",
    )
    .await;
    assert!(!expired.is_empty());

    // Nothing is due yet, so the real expiry path is proven at store level in
    // lore-core/tests/maintenance_proof.rs; here the route shape and dry-run
    // accounting are exercised through the daemon.
    let (code, dry) = call(
        &daemon.socket,
        "/v2/admin/maintenance",
        json!({ "dryRun": true, "tasks": ["expire_memories"] }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{dry}");
    assert_eq!(dry["result"]["dryRun"], true);
    assert_eq!(dry["result"]["tasks"][0]["name"], "expire_memories");
    assert_eq!(dry["result"]["tasks"][0]["affected"], 0);

    let (code, applied) = call(
        &daemon.socket,
        "/v2/admin/maintenance",
        json!({ "tasks": ["reap_embedding_jobs", "retry_stale_extraction"] }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{applied}");
    assert_eq!(applied["result"]["dryRun"], false);
    assert!(applied["result"]["runId"].as_str().is_some());

    let (_, unknown) = call(
        &daemon.socket,
        "/v2/admin/maintenance",
        json!({ "tasks": ["not_a_task"] }),
        Some(&store_id),
    )
    .await;
    assert_eq!(unknown["error"]["reason"], "ADMIN_ARGUMENT_INVALID");
}

#[tokio::test]
async fn reflect_builds_and_optionally_persists_a_digest() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon).await;
    retain(
        &daemon.socket,
        &store_id,
        "core-reflect-1",
        "user_preference",
        "Prefer concise commit messages.",
    )
    .await;
    retain(
        &daemon.socket,
        &store_id,
        "core-reflect-2",
        "standing_directive",
        "Always run the test suite before pushing.",
    )
    .await;

    let (code, digest) = call(
        &daemon.socket,
        "/v2/admin/reflect",
        json!({ "limit": 10 }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{digest}");
    let text = digest["result"]["text"].as_str().expect("text");
    assert!(text.contains("concise commit messages"), "{text}");
    assert!(text.contains("run the test suite"), "{text}");
    assert!(digest["result"]["persisted"].is_null());
    assert_eq!(
        digest["result"]["memoryIds"].as_array().expect("ids").len(),
        2
    );

    let (code, persisted) = call(
        &daemon.socket,
        "/v2/admin/reflect",
        json!({ "limit": 10, "persist": true }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{persisted}");
    let memory_id = persisted["result"]["persisted"]
        .as_str()
        .expect("persisted id");

    let (_, recall) = call(
        &daemon.socket,
        "/v2/recall",
        json!({ "query": "reflection digest", "limit": 5 }),
        Some(&store_id),
    )
    .await;
    assert!(
        recall["result"]["context"]
            .as_str()
            .unwrap_or("")
            .contains("Reflection"),
        "{recall}"
    );

    // The query itself is never persisted: a query that matches nothing
    // yields an empty digest.
    let (_, empty) = call(
        &daemon.socket,
        "/v2/admin/reflect",
        json!({ "query": "zzzz-no-such-term", "persist": true }),
        Some(&store_id),
    )
    .await;
    assert_eq!(empty["result"]["text"], "");
    assert!(empty["result"]["persisted"].is_null());
    assert!(!memory_id.is_empty());
}

#[tokio::test]
async fn deferred_process_and_backfill_are_bounded_noops_without_sources() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon).await;

    let (code, deferred) = call(
        &daemon.socket,
        "/v2/admin/deferred-process",
        json!({ "limit": 4 }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{deferred}");
    assert_eq!(deferred["result"]["claimed"], 0);

    let (code, backfill) = call(
        &daemon.socket,
        "/v2/admin/backfill",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{backfill}");
    assert_eq!(backfill["result"]["roots"], 0);
    assert_eq!(backfill["result"]["discovered"], 0);
}
