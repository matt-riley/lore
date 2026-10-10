//! An unfinished migration import must not serve memory operations.

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use protocol::RequestMeta;
use serde_json::{Value, json};

#[tokio::test]
async fn unfinished_import_stores_are_unavailable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let socket = dir.path().join("lored.sock");
    let config_path = dir.path().join("lore.json");
    let config = json!({
        "configVersion": 2,
        "enabled": true,
        "dataDir": dir.path().to_str().expect("utf8"),
        "socketPath": socket.to_str().expect("utf8")
    });
    std::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&config).expect("config"),
    )
    .expect("write config");

    // Stage an import in the destination store.
    {
        let resolved = lore_core::config::ResolvedConfig::load(Some(&config_path), None, None)
            .expect("config");
        let store = lore_core::store::Store::open(&resolved).expect("open");
        store
            .begin_migration("run-1", 20, "fingerprint", "/tmp/v1.db", 1_000)
            .expect("manifest");
    }

    let mut child: Child = Command::new(env!("CARGO_BIN_EXE_lored"))
        .arg("--config")
        .arg(&config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn lored");

    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let status = wait_for_status(&socket).await;
        assert_eq!(status["result"]["readiness"], "unavailable", "{status}");
        assert_eq!(status["result"]["reason"], "MIGRATION_INCOMPLETE");

        let mut meta = meta();
        meta.expected_store_id = status["storeId"].as_str().map(str::to_string);
        let outcome = lore::request(
            &socket,
            "/v2/retain",
            meta,
            json!({
                "idempotencyKey": "blocked",
                "type": "note",
                "content": "must not be written",
                "scope": "global"
            }),
        )
        .await
        .expect("retain");
        assert_eq!(outcome.status_code, 412, "body: {}", outcome.body);
        let body: Value = serde_json::from_str(&outcome.body).expect("json");
        assert_eq!(body["error"]["reason"], "MIGRATION_INCOMPLETE");
    })
    .await;
    let _ = child.kill();
    let _ = child.wait();
    result.expect("gate checks completed");
}

fn meta() -> RequestMeta {
    RequestMeta {
        client_id: "test.gate".to_string(),
        request_id: "request-gate".to_string(),
        session_id: None,
        expected_store_id: None,
        timeout_ms: None,
        required_capabilities: Vec::new(),
    }
}

async fn wait_for_status(socket: &Path) -> Value {
    for _ in 0..500 {
        if let Ok(outcome) = lore::request(socket, "/v2/status", meta(), json!({})).await
            && outcome.status_code == 200
            && let Ok(body) = serde_json::from_str::<Value>(&outcome.body)
        {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon never reported status");
}
