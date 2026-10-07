//! Dashboard view routes: shapes, filters, drill-down and capability.

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

fn meta() -> RequestMeta {
    RequestMeta {
        client_id: "test.rust.views".to_string(),
        request_id: format!("request-{}", uuid::Uuid::new_v4()),
        session_id: None,
        expected_store_id: None,
        timeout_ms: None,
        required_capabilities: Vec::new(),
    }
}

async fn call(socket: &Path, route: &str, params: Value, store_id: Option<&str>) -> (u16, Value) {
    for _ in 0..500 {
        let mut meta = meta();
        meta.expected_store_id = store_id.map(str::to_string);
        let outcome = lore::request(socket, route, meta, params.clone()).await;
        if let Ok(outcome) = outcome {
            let body = serde_json::from_str::<Value>(&outcome.body).unwrap_or(Value::Null);
            return (outcome.status_code, body);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon never accepted requests");
}

async fn store_id(socket: &Path) -> String {
    let (status, body) = call(socket, "/v2/status", json!({}), None).await;
    assert_eq!(status, 200, "{body}");
    body["storeId"].as_str().expect("store id").to_string()
}

#[tokio::test]
async fn views_report_store_state_filters_and_drilldown() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon.socket).await;

    let (status, status_body) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    assert_eq!(status, 200);
    assert!(
        status_body["result"]["capabilities"]
            .as_array()
            .expect("capabilities")
            .iter()
            .any(|capability| capability == "views.read"),
        "{status_body}"
    );

    // Retain two memories and forget one.
    let mut meta = meta();
    meta.expected_store_id = Some(store_id.clone());
    let retained = lore::request(
        &daemon.socket,
        "/v2/retain",
        meta.clone(),
        json!({
            "idempotencyKey": "view-retain-1",
            "type": "note",
            "content": "Dashboard view keeps this memory.",
            "scope": "global"
        }),
    )
    .await
    .expect("retain");
    assert_eq!(retained.status_code, 200, "{}", retained.body);
    let first_id =
        serde_json::from_str::<Value>(&retained.body).expect("json")["result"]["memoryId"]
            .as_str()
            .expect("memory id")
            .to_string();
    let second = lore::request(
        &daemon.socket,
        "/v2/retain",
        meta.clone(),
        json!({
            "idempotencyKey": "view-retain-2",
            "type": "decision",
            "content": "Dashboard view forgets this decision.",
            "scope": "global"
        }),
    )
    .await
    .expect("retain");
    let second_id =
        serde_json::from_str::<Value>(&second.body).expect("json")["result"]["memoryId"]
            .as_str()
            .expect("memory id")
            .to_string();
    let forgotten = lore::request(
        &daemon.socket,
        "/v2/forget",
        meta,
        json!({ "idempotencyKey": "view-forget-1", "memoryId": second_id }),
    )
    .await
    .expect("forget");
    assert_eq!(forgotten.status_code, 200, "{}", forgotten.body);

    let (status, overview) = call(
        &daemon.socket,
        "/v2/views/overview",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(status, 200, "{overview}");
    assert_eq!(overview["result"]["activeMemories"], 1);
    assert_eq!(overview["result"]["forgottenMemories"], 1);
    assert_eq!(overview["result"]["schemaVersion"], 6);

    let (status, health) = call(
        &daemon.socket,
        "/v2/views/health",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(health["result"]["ready"], true);
    assert_eq!(health["result"]["ftsHealthy"], true);

    let (_, memories) = call(
        &daemon.socket,
        "/v2/views/memories",
        json!({ "limit": 10 }),
        Some(&store_id),
    )
    .await;
    let items = memories["result"]["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "{memories}");
    assert_eq!(items[0]["id"], first_id);

    let (_, decisions) = call(
        &daemon.socket,
        "/v2/views/memories",
        json!({ "kind": "decision" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(
        decisions["result"]["items"]
            .as_array()
            .expect("items")
            .len(),
        0
    );

    let (_, filters) = call(
        &daemon.socket,
        "/v2/views/memories/filters",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert!(filters["result"]["kinds"].is_array(), "{filters}");
    assert!(filters["result"]["scopes"].is_array());

    let (_, maintenance) = call(
        &daemon.socket,
        "/v2/views/maintenance",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert!(
        maintenance["result"]["extraction"].is_array(),
        "{maintenance}"
    );
    assert!(maintenance["result"]["sources"].is_array());

    let (_, episodes) = call(
        &daemon.socket,
        "/v2/views/episodes",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(
        episodes["result"]["episodes"]
            .as_array()
            .expect("episodes")
            .len(),
        0
    );
    assert!(episodes["result"]["extractionRuns"].is_array());

    let (_, drilldown) = call(
        &daemon.socket,
        "/v2/views/drilldown",
        json!({ "id": first_id }),
        Some(&store_id),
    )
    .await;
    assert_eq!(drilldown["result"]["found"], true);
    assert_eq!(drilldown["result"]["suppressed"], false);
    assert!(drilldown["result"]["evidence"].is_array());

    let (_, forgotten_view) = call(
        &daemon.socket,
        "/v2/views/drilldown",
        json!({ "id": second_id, "includeForgotten": true }),
        Some(&store_id),
    )
    .await;
    assert_eq!(forgotten_view["result"]["found"], true);
    assert_eq!(
        forgotten_view["result"]["suppressed"], true,
        "{forgotten_view}"
    );

    let (status, unknown) = call(
        &daemon.socket,
        "/v2/views/not-a-view",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(status, 501, "{unknown}");
}
