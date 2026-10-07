//! End-to-end extraction: capture, apply, recall, suppression and correction.

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
    fn start(fixture: &str) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("lored.sock");
        let sources = dir.path().join("sources");
        std::fs::create_dir_all(&sources).expect("sources dir");
        std::fs::write(sources.join("session.jsonl"), fixture).expect("fixture");
        let config_path = dir.path().join("lore.json");
        let config = json!({
            "configVersion": 2,
            "enabled": true,
            "dataDir": dir.path().to_str().expect("utf8"),
            "socketPath": socket.to_str().expect("utf8"),
            "sources": {
                "roots": [{
                    "rootId": "pi-root",
                    "client": "pi",
                    "path": sources.to_str().expect("utf8"),
                    "repository": "acme/checkout"
                }],
                "sweepSeconds": 5
            }
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

fn meta() -> RequestMeta {
    RequestMeta {
        client_id: "test.rust.extraction".to_string(),
        request_id: format!("request-{}", uuid::Uuid::new_v4()),
        session_id: None,
        expected_store_id: None,
        timeout_ms: None,
        required_capabilities: Vec::new(),
    }
}

async fn store_id(socket: &Path) -> String {
    for _ in 0..500 {
        if let Ok(outcome) = lore::request(socket, "/v2/status", meta(), json!({})).await
            && outcome.status_code == 200
            && let Ok(body) = serde_json::from_str::<Value>(&outcome.body)
            && let Some(store_id) = body["storeId"].as_str()
        {
            return store_id.to_string();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon did not report a store id");
}

async fn call(socket: &Path, route: &str, params: Value) -> (u16, Value) {
    let store = store_id(socket).await;
    for _ in 0..500 {
        let mut meta = meta();
        meta.expected_store_id = Some(store.clone());
        match lore::request(socket, route, meta, params.clone()).await {
            Ok(outcome) => {
                let body = serde_json::from_str::<Value>(&outcome.body).unwrap_or(Value::Null);
                return (outcome.status_code, body);
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    panic!("daemon did not accept requests");
}

async fn recall(socket: &Path, query: &str) -> Value {
    let (status, body) = call(
        socket,
        "/v2/recall",
        json!({ "query": query, "limit": 12, "repository": "acme/checkout" }),
    )
    .await;
    assert_eq!(status, 200, "body: {body}");
    body
}

fn memories(body: &Value) -> Vec<Value> {
    body["result"]["records"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn contains(body: &Value, needle: &str) -> bool {
    memories(body).iter().any(|memory| {
        memory["content"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .contains(needle)
    })
}

/// Hint the source until extraction surfaces a memory (or time out).
async fn wait_for_memory(socket: &Path, query: &str, needle: &str) -> Value {
    for attempt in 0..200 {
        if attempt % 20 == 0 {
            let (_, status) = call(socket, "/v2/sources/status", json!({ "limit": 10 })).await;
            if let Some(source) = status["result"]["sources"]
                .as_array()
                .and_then(|rows| rows.first())
                && let Some(source_id) = source["sourceId"].as_str()
            {
                let _ = call(
                    socket,
                    "/v2/sources/hint",
                    json!({
                        "idempotencyKey": format!("hint-{attempt}"),
                        "sourceId": source_id,
                        "eventId": format!("event-{attempt}"),
                        "event": "append"
                    }),
                )
                .await;
            }
        }
        let body = recall(socket, query).await;
        if contains(&body, needle) {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("memory containing {needle:?} never surfaced");
}

const PREFERENCE_FIXTURE: &str = concat!(
    "{\"type\":\"session\",\"id\":\"extract-1\",\"cwd\":\"/work\"}\n",
    "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"For this service, please prefer UTC timestamps in persisted records so ordering is stable.\"}}\n",
    "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"I will persist UTC timestamps for stable ordering.\"}}\n",
);

const CORRECTION_FIXTURE: &str = concat!(
    "{\"type\":\"session\",\"id\":\"extract-2\",\"cwd\":\"/work\"}\n",
    "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Use a 30 second timeout for the worker.\"}}\n",
    "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"The worker timeout will be 30 seconds.\"}}\n",
    "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Actually, that is wrong: use a 45 second timeout because the upstream batch window is longer.\"}}\n",
    "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"The corrected worker timeout is 45 seconds.\"}}\n",
);

#[tokio::test]
async fn extraction_applies_scoped_automatic_memories_with_evidence() {
    let daemon = Daemon::start(PREFERENCE_FIXTURE);
    let _ = store_id(&daemon.socket).await;
    let body = wait_for_memory(&daemon.socket, "UTC timestamps persisted records", "utc").await;
    let memory = memories(&body)
        .into_iter()
        .find(|memory| {
            memory["content"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains("utc")
        })
        .expect("extracted memory");
    assert_eq!(memory["authority"], "auto");
    assert_eq!(memory["scope"], "repo");
    assert_eq!(memory["repository"], "acme/checkout");
    assert_eq!(memory["type"], "user_preference");
    assert!(
        memory["tags"]
            .as_array()
            .expect("tags")
            .iter()
            .any(|tag| tag == "user"),
        "evidence role is attributed"
    );

    // Explicit reprocessing reschedules completed work under the active rules.
    let (status, retry) = call(
        &daemon.socket,
        "/v2/extraction/retry",
        json!({ "idempotencyKey": "retry-1" }),
    )
    .await;
    assert_eq!(status, 200, "body: {retry}");
    assert!(
        retry["result"]["reset"].is_u64(),
        "reset count must be reported: {retry}"
    );
    assert_eq!(retry["result"]["ruleVersion"], "rules-v1");
}

#[tokio::test]
async fn required_sections_return_without_a_topical_match() {
    let daemon = Daemon::start(PREFERENCE_FIXTURE);
    let _ = store_id(&daemon.socket).await;
    let _ = wait_for_memory(&daemon.socket, "UTC timestamps persisted records", "utc").await;

    // No matching terms: mandatory guidance still renders, and topical is empty.
    let (status, body) = call(
        &daemon.socket,
        "/v2/recall",
        json!({ "query": "what is the capital of finland", "repository": "acme/checkout", "limit": 12 }),
    )
    .await;
    assert_eq!(status, 200, "body: {body}");
    assert!(
        contains(&body, "utc"),
        "required preferences must be assembled without topical terms: {body}"
    );
    let sections = body["result"]["sections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        sections
            .iter()
            .any(|section| section["id"] == "preferences"),
        "section accounting names the preference block: {sections:?}"
    );

    // A tiny budget truncates required content visibly instead of hiding it.
    let (status, tiny) = call(
        &daemon.socket,
        "/v2/recall",
        json!({
            "query": "what is the capital of finland",
            "repository": "acme/checkout",
            "contextBytes": 30
        }),
    )
    .await;
    assert_eq!(status, 200, "body: {tiny}");
    assert_eq!(
        tiny["result"]["diagnostics"]["mandatoryTruncated"], true,
        "pathological budgets must report truncation: {tiny}"
    );
}

#[tokio::test]
async fn forgetting_an_extracted_memory_survives_reread() {
    let daemon = Daemon::start(PREFERENCE_FIXTURE);
    let _ = store_id(&daemon.socket).await;
    let body = wait_for_memory(&daemon.socket, "UTC timestamps persisted records", "utc").await;
    let memory = memories(&body)
        .into_iter()
        .find(|memory| {
            memory["content"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains("utc")
        })
        .expect("extracted memory");
    let memory_id = memory["id"].as_str().expect("id").to_string();

    let (status, forgotten) = call(
        &daemon.socket,
        "/v2/forget",
        json!({ "idempotencyKey": "forget-extracted", "memoryId": memory_id }),
    )
    .await;
    assert_eq!(status, 200, "body: {forgotten}");

    // Re-reading the source must not resurrect the forgotten proposition:
    // suppression is checked before proposal creation and before apply.
    for attempt in 0..60 {
        let (_, status) = call(&daemon.socket, "/v2/sources/status", json!({ "limit": 10 })).await;
        if let Some(source_id) = status["result"]["sources"]
            .as_array()
            .and_then(|rows| rows.first())
            .and_then(|row| row["sourceId"].as_str())
        {
            let _ = call(
                &daemon.socket,
                "/v2/sources/hint",
                json!({
                    "idempotencyKey": format!("resurrect-hint-{attempt}"),
                    "sourceId": source_id,
                    "eventId": format!("resurrect-{attempt}"),
                    "event": "append"
                }),
            )
            .await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        let body = recall(&daemon.socket, "UTC timestamps persisted records").await;
        if contains(&body, "utc") {
            panic!("forgotten proposition was resurrected: {body}");
        }
    }
}

#[tokio::test]
async fn corrections_retire_the_superseded_memory() {
    let daemon = Daemon::start(CORRECTION_FIXTURE);
    let _ = store_id(&daemon.socket).await;
    let body = wait_for_memory(&daemon.socket, "worker timeout seconds", "45 second").await;
    assert!(
        !contains(&body, "30 second"),
        "the superseded timeout stayed active: {body}"
    );
    let corrected = memories(&body)
        .into_iter()
        .find(|memory| {
            memory["content"]
                .as_str()
                .unwrap_or("")
                .contains("45 second")
        })
        .expect("corrected memory");
    assert_eq!(corrected["authority"], "auto");
}
