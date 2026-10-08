//! Episode digests and day summaries produced from captured sources.

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
        let sources = dir.path().join("sources");
        std::fs::create_dir_all(&sources).expect("sources dir");
        std::fs::write(
            sources.join("session.jsonl"),
            concat!(
                "{\"type\":\"session\",\"id\":\"digest-session-1\",\"cwd\":\"/work\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Please always prefer small pure functions for this repository.\"}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"I will keep functions small and pure.\"}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Also remember to run schema validation before copying rows.\"}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"I will run schema validation before copying rows.\"}}\n"
            ),
        )
        .expect("fixture");
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
                    "path": sources.to_str().expect("utf8")
                }],
                "sweepSeconds": 60
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

fn meta(store_id: Option<&str>) -> RequestMeta {
    RequestMeta {
        client_id: "test.rust.digest".to_string(),
        request_id: format!("request-{}", uuid::Uuid::new_v4()),
        session_id: None,
        expected_store_id: store_id.map(str::to_string),
        timeout_ms: None,
        required_capabilities: Vec::new(),
    }
}

async fn call(socket: &Path, route: &str, params: Value, store_id: Option<&str>) -> Value {
    for _ in 0..500 {
        if let Ok(outcome) = lore::request(socket, route, meta(store_id), params.clone()).await {
            let body: Value = serde_json::from_str(&outcome.body).unwrap_or(Value::Null);
            if outcome.status_code == 200 && body["ok"] == true {
                return body["result"].clone();
            }
            if outcome.status_code >= 400 && body["ok"] == false {
                return body;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon never accepted requests");
}

async fn store_id(socket: &Path) -> String {
    let result = call(socket, "/v2/status", json!({}), None).await;
    result["storeId"].as_str().expect("store").to_string()
}

#[tokio::test]
async fn captured_sessions_produce_episode_digests_and_day_summaries() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon.socket).await;

    // Discovery, capture and extraction run in the background scheduler; the
    // deferred processor drains extraction and the digests that follow it.
    // Poll until the episode appears rather than racing the scheduler.
    let mut episodes = Value::Null;
    for _ in 0..100 {
        let _ = call(
            &daemon.socket,
            "/v2/admin/backfill",
            json!({}),
            Some(&store_id),
        )
        .await;
        let _ = call(
            &daemon.socket,
            "/v2/admin/deferred-process",
            json!({ "limit": 8 }),
            Some(&store_id),
        )
        .await;
        episodes = call(
            &daemon.socket,
            "/v2/views/episodes",
            json!({}),
            Some(&store_id),
        )
        .await;
        if episodes["episodes"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let episodes_list = episodes["episodes"].as_array().expect("episodes");
    assert_eq!(episodes_list.len(), 1, "{episodes}");
    let episode = &episodes_list[0];
    assert_eq!(episode["sessionId"], "digest-session-1");
    assert_eq!(episode["scope"], "global");
    assert!(
        episode["summary"]
            .as_str()
            .unwrap_or("")
            .contains("Episode")
    );
    assert!(
        episode["summary"]
            .as_str()
            .unwrap_or("")
            .contains("Turns: 2 user")
    );
    let date_key = episode["dateKey"].as_str().expect("date key");
    assert_eq!(date_key.len(), 10, "{date_key}");
    assert!(
        ["routine", "notable", "significant"]
            .contains(&episode["significance"].as_str().unwrap_or(""))
    );

    let days = episodes["daySummaries"].as_array().expect("days");
    assert_eq!(days.len(), 1, "{episodes}");
    assert_eq!(days[0]["dateKey"], date_key);
    assert!(
        days[0]["summary"]
            .as_str()
            .unwrap_or("")
            .contains("# Day summary")
    );

    // A second pass is idempotent: one episode, one day summary.
    let _ = call(
        &daemon.socket,
        "/v2/admin/deferred-process",
        json!({ "limit": 8 }),
        Some(&store_id),
    )
    .await;
    let episodes = call(
        &daemon.socket,
        "/v2/views/episodes",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(episodes["episodes"].as_array().expect("episodes").len(), 1);
    assert_eq!(episodes["daySummaries"].as_array().expect("days").len(), 1);

    // Digests are ordinary searchable memories.
    let recalled = call(
        &daemon.socket,
        "/v2/recall",
        json!({ "query": "episode summary", "limit": 5 }),
        Some(&store_id),
    )
    .await;
    assert!(
        recalled["context"]
            .as_str()
            .unwrap_or("")
            .contains("Episode"),
        "{recalled}"
    );
}
