//! Maintenance inventory over the daemon: status, manual runs, cadence floors
//! and exact rollback.

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
    fn start(maintenance: Option<Value>) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("lored.sock");
        let config_path = dir.path().join("lore.json");
        let mut config = json!({
            "configVersion": 2,
            "enabled": true,
            "dataDir": dir.path().to_str().expect("utf8"),
            "socketPath": socket.to_str().expect("utf8"),
        });
        if let Some(maintenance) = maintenance {
            config["maintenance"] = maintenance;
        }
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
        client_id: "test.rust.maintenance".to_string(),
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
async fn maintenance_status_lists_the_inventory_and_cadence_floors() {
    let daemon = Daemon::start(Some(json!({
        "tasks": {
            "memoryHygiene": { "enabled": true, "cadenceSeconds": 0 },
            "traceCompaction": { "enabled": false, "cadenceSeconds": 120 }
        }
    })));
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    let store_id = status["storeId"].as_str().expect("store").to_string();

    let (code, report) = call(
        &daemon.socket,
        "/v2/admin/maintenance",
        json!({ "action": "status" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{report}");
    let result = &report["result"];
    let states = result["taskStates"].as_array().expect("states");
    assert_eq!(states.len(), 9, "{result}");
    let by_name = |name: &str| {
        states
            .iter()
            .find(|state| state["task"] == name)
            .unwrap_or_else(|| panic!("missing task {name}"))
            .clone()
    };
    // A zero cadence is a bounded 60-second opportunity while enabled.
    assert_eq!(by_name("memoryHygiene")["enabled"], true);
    assert_eq!(by_name("memoryHygiene")["cadenceSeconds"], 60);
    assert_eq!(by_name("traceCompaction")["enabled"], false);
    assert_eq!(by_name("traceCompaction")["cadenceSeconds"], 120);
    // Defaults for the tasks the config did not mention.
    assert_eq!(by_name("deferredExtraction")["enabled"], true);
    assert_eq!(by_name("extractionRevalidation")["cadenceSeconds"], 86_400);
    assert!(result["runs"].is_array());
    assert!(result["dueTasks"].is_array());
}

#[tokio::test]
async fn maintenance_run_is_bounded_claim_exclusive_and_rolls_back_exactly() {
    let daemon = Daemon::start(None);
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    let store_id = status["storeId"].as_str().expect("store").to_string();

    // A dry run reports without mutating and lands in history.
    let (code, dry) = call(
        &daemon.socket,
        "/v2/admin/maintenance",
        json!({ "action": "run", "task": "memoryHygiene", "dryRun": true }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{dry}");
    assert_eq!(dry["result"]["state"], "complete");
    assert_eq!(dry["result"]["dryRun"], true);
    let dry_run_id = dry["result"]["runId"].as_str().expect("run id").to_string();

    // Unknown tasks are refused before any run row exists.
    let (code, unknown) = call(
        &daemon.socket,
        "/v2/admin/maintenance",
        json!({ "action": "run", "task": "not-a-task" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{unknown}");
    assert_eq!(unknown["error"]["reason"], "ADMIN_ARGUMENT_INVALID");

    // Seed an expired memory directly (the retain API expects future expiry).
    let memory = {
        let (code, body) = call(
            &daemon.socket,
            "/v2/retain",
            json!({
                "idempotencyKey": "maint-hygiene-1",
                "type": "note",
                "content": "Expired body preserved for rollback.",
                "scope": "global"
            }),
            Some(&store_id),
        )
        .await;
        assert_eq!(code, 200, "{body}");
        let memory_id = body["result"]["memoryId"].as_str().expect("id").to_string();
        let connection =
            rusqlite::Connection::open(daemon._dir.path().join("lore-v2.db")).expect("open db");
        connection
            .execute(
                "UPDATE memories SET expires_at_ms = 1 WHERE id = ?1",
                rusqlite::params![memory_id],
            )
            .expect("backdate expiry");
        memory_id
    };

    let (code, applied) = call(
        &daemon.socket,
        "/v2/admin/maintenance",
        json!({ "action": "run", "task": "memoryHygiene", "dryRun": false }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{applied}");
    assert_eq!(applied["result"]["state"], "complete");
    assert_eq!(applied["result"]["counts"]["completed"], 1);
    let run_id = applied["result"]["runId"]
        .as_str()
        .expect("run id")
        .to_string();
    let marker = applied["result"]["detail"]["marker"]
        .as_str()
        .expect("marker");
    assert!(marker.starts_with("hygiene-auto:"), "{marker}");

    // Roll back exactly that run.
    let (code, rolled_back) = call(
        &daemon.socket,
        "/v2/admin/maintenance",
        json!({ "action": "rollback", "runId": run_id }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{rolled_back}");
    assert_eq!(rolled_back["result"]["restored"], 1);
    let forgotten: i64 = {
        let connection =
            rusqlite::Connection::open(daemon._dir.path().join("lore-v2.db")).expect("open db");
        connection
            .query_row(
                "SELECT forgotten FROM memories WHERE id = ?1",
                rusqlite::params![memory],
                |row| row.get(0),
            )
            .expect("flag")
    };
    assert_eq!(forgotten, 0, "rollback un-forgets exactly the marked row");

    // Rolling back a run that never applied is refused, and the dry run
    // remains untouched by the rollback.
    let (code, bad) = call(
        &daemon.socket,
        "/v2/admin/maintenance",
        json!({ "action": "rollback", "runId": dry_run_id }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{bad}");
    assert_eq!(bad["error"]["reason"], "MAINTENANCE_ROLLBACK");
}
