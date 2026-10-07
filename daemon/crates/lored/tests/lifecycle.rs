//! Stage-2 lifecycle: ownership, stale sockets, drain and crash recovery.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use protocol::RequestMeta;
use serde_json::json;

fn write_config(dir: &Path, enabled: bool, socket: &Path) -> PathBuf {
    let config = dir.join("lore.json");
    let document = json!({
        "configVersion": 2,
        "enabled": enabled,
        "dataDir": dir.to_str().expect("utf8 dir"),
        "socketPath": socket.to_str().expect("utf8 socket"),
    });
    std::fs::write(
        &config,
        serde_json::to_vec_pretty(&document).expect("config json"),
    )
    .expect("write config");
    config
}

fn spawn(dir: &Path, enabled: bool) -> (Child, PathBuf) {
    let socket = dir.join("lored.sock");
    let config = write_config(dir, enabled, &socket);
    let child = Command::new(env!("CARGO_BIN_EXE_lored"))
        .arg("--config")
        .arg(&config)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn lored");
    (child, socket)
}

async fn wait_for_socket(path: &Path) -> bool {
    for _ in 0..500 {
        if path.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

async fn wait_for_live_status(path: &Path) -> bool {
    for _ in 0..500 {
        if let Ok(outcome) = lore::request(path, "/v2/status", meta(), json!({})).await
            && outcome.status_code == 200
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

fn meta() -> RequestMeta {
    RequestMeta {
        client_id: "test.rust".to_string(),
        request_id: "request-1".to_string(),
        session_id: None,
        expected_store_id: None,
        timeout_ms: None,
        required_capabilities: Vec::new(),
    }
}

async fn status(socket: &Path) -> serde_json::Value {
    let outcome = lore::request(socket, "/v2/status", meta(), json!({}))
        .await
        .expect("status");
    assert_eq!(outcome.status_code, 200, "body: {}", outcome.body);
    serde_json::from_str(&outcome.body).expect("json")
}

fn store_meta(store_id: &str) -> RequestMeta {
    RequestMeta {
        expected_store_id: Some(store_id.to_string()),
        ..meta()
    }
}

#[tokio::test]
async fn sigterm_drains_and_removes_only_its_own_socket() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut child, socket) = spawn(dir.path(), true);
    assert!(wait_for_socket(&socket).await, "socket should appear");

    // SAFETY: sending SIGTERM to a child we own.
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let status = child.wait().expect("wait");
    assert!(status.success(), "SIGTERM should drain cleanly: {status:?}");
    assert!(!socket.exists(), "a clean shutdown removes its own socket");
}

#[tokio::test]
async fn sigkill_then_restart_recovers_acknowledged_writes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut child, socket) = spawn(dir.path(), true);
    assert!(wait_for_live_status(&socket).await);

    let first_status = status(&socket).await;
    let store_id = first_status["storeId"]
        .as_str()
        .expect("storeId")
        .to_string();
    let retained = lore::request(
        &socket,
        "/v2/retain",
        store_meta(&store_id),
        json!({
            "idempotencyKey": "durable-1",
            "type": "note",
            "content": "acknowledged before the crash",
            "scope": "global"
        }),
    )
    .await
    .expect("retain");
    assert_eq!(retained.status_code, 200, "body: {}", retained.body);
    let memory_id = serde_json::from_str::<serde_json::Value>(&retained.body).expect("json")
        ["result"]["memoryId"]
        .as_str()
        .expect("memoryId")
        .to_string();

    child.kill().expect("SIGKILL");
    child.wait().expect("wait");
    assert!(socket.exists(), "SIGKILL leaves the socket inode behind");

    let (mut restarted, restarted_socket) = spawn(dir.path(), true);
    assert_eq!(restarted_socket, socket);
    assert!(
        wait_for_live_status(&socket).await,
        "a restart must clear the stale socket and bind"
    );

    let recalled = lore::request(
        &socket,
        "/v2/recall",
        store_meta(&store_id),
        json!({ "query": "acknowledged before the crash" }),
    )
    .await
    .expect("recall");
    assert_eq!(recalled.status_code, 200, "body: {}", recalled.body);
    let value: serde_json::Value = serde_json::from_str(&recalled.body).expect("json");
    assert_eq!(
        value["result"]["records"]
            .as_array()
            .expect("records")
            .len(),
        1
    );
    assert_eq!(value["result"]["records"][0]["id"], memory_id);

    let replay = lore::request(
        &socket,
        "/v2/retain",
        store_meta(&store_id),
        json!({
            "idempotencyKey": "durable-1",
            "type": "note",
            "content": "acknowledged before the crash",
            "scope": "global"
        }),
    )
    .await
    .expect("replay");
    let replay_value: serde_json::Value = serde_json::from_str(&replay.body).expect("json");
    assert_eq!(replay_value["result"]["memoryId"], memory_id);
    assert_eq!(replay_value["result"]["writeResult"], "created");

    let _ = restarted.kill();
    let _ = restarted.wait();
}

#[tokio::test]
async fn a_different_store_cannot_take_a_live_socket() {
    let dir_a = tempfile::tempdir().expect("tempdir a");
    let dir_b = tempfile::tempdir().expect("tempdir b");
    let (mut child_a, socket_a) = spawn(dir_a.path(), true);
    assert!(wait_for_socket(&socket_a).await);

    let config_b = dir_b.path().join("lore.json");
    std::fs::write(
        &config_b,
        serde_json::to_vec_pretty(&json!({
            "configVersion": 2,
            "enabled": true,
            "dataDir": dir_b.path().to_str().expect("utf8"),
            "socketPath": socket_a.to_str().expect("utf8"),
        }))
        .expect("json"),
    )
    .expect("write config b");
    let output = Command::new(env!("CARGO_BIN_EXE_lored"))
        .arg("--config")
        .arg(&config_b)
        .output()
        .expect("spawn rival");
    assert!(
        !output.status.success(),
        "a live socket must not be replaced"
    );

    let value = status(&socket_a).await;
    assert_eq!(value["ok"], true, "the original daemon keeps serving");
    let _ = child_a.kill();
    let _ = child_a.wait();
}

#[tokio::test]
async fn unsafe_endpoints_and_v1_databases_are_refused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let socket = dir.path().join("lored.sock");
    std::os::unix::fs::symlink(dir.path().join("elsewhere.sock"), &socket).expect("symlink");
    let config = write_config(dir.path(), true, &socket);
    let output = Command::new(env!("CARGO_BIN_EXE_lored"))
        .arg("--config")
        .arg(&config)
        .output()
        .expect("spawn");
    assert!(!output.status.success(), "a symlinked endpoint is refused");

    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("lore.db"), b"not really v1").expect("v1 file");
    let (mut child, _) = spawn(dir.path(), true);
    let status = child.wait().expect("wait");
    assert!(!status.success(), "a directory holding lore.db is refused");
}

#[tokio::test]
async fn disabled_config_serves_status_but_rejects_mutations() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut child, socket) = spawn(dir.path(), false);
    assert!(wait_for_socket(&socket).await);

    let value = status(&socket).await;
    assert_eq!(value["result"]["readiness"], "unavailable");
    assert_eq!(value["result"]["reason"], "CONFIG_DISABLED");
    assert_eq!(value["result"]["capabilities"], json!(["status.basic"]));

    let store_id = value["storeId"].as_str().expect("storeId");
    let retained = lore::request(
        &socket,
        "/v2/retain",
        store_meta(store_id),
        json!({
            "idempotencyKey": "disabled-1",
            "type": "note",
            "content": "must not be written",
            "scope": "global"
        }),
    )
    .await
    .expect("retain");
    assert_eq!(retained.status_code, 412);
    let body: serde_json::Value = serde_json::from_str(&retained.body).expect("json");
    assert_eq!(body["error"]["reason"], "CONFIG_DISABLED");

    let _ = child.kill();
    let _ = child.wait();
}
