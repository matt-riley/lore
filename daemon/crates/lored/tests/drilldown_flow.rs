//! Drill-down depth: supersession lineage, canonical grouping and the graph.

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

    fn database(&self) -> PathBuf {
        self._dir.path().join("lore-v2.db")
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
        client_id: "test.rust.drilldown".to_string(),
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

async fn store_id(socket: &Path) -> String {
    let (_, status) = call(socket, "/v2/status", json!({}), None).await;
    status["storeId"].as_str().expect("store").to_string()
}

async fn retain(socket: &Path, store_id: &str, key: &str, content: &str) -> String {
    let (code, body) = call(
        socket,
        "/v2/retain",
        json!({
            "idempotencyKey": key,
            "type": "note",
            "content": content,
            "scope": "global"
        }),
        Some(store_id),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    body["result"]["memoryId"].as_str().expect("id").to_string()
}

#[tokio::test]
async fn drilldown_reports_lineage_canonical_grouping_and_a_consistent_graph() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon.socket).await;
    let original = retain(
        &daemon.socket,
        &store_id,
        "drill-original",
        "Original body for lineage.",
    )
    .await;
    let replacement = retain(
        &daemon.socket,
        &store_id,
        "drill-replacement",
        "Replacement body for lineage.",
    )
    .await;
    // Shape the store: original retired by replacement, both sharing a topic key.
    {
        let connection = rusqlite::Connection::open(daemon.database()).expect("db");
        connection
            .execute(
                "UPDATE memories SET superseded_by = ?1, topic_key = 'topic-shared' WHERE id = ?2",
                rusqlite::params![replacement, original],
            )
            .expect("retire original");
        connection
            .execute(
                "UPDATE memories SET topic_key = 'topic-shared' WHERE id = ?1",
                rusqlite::params![replacement],
            )
            .expect("topic key");
    }

    // The retired original reports its successor, predecessor-free lineage
    // and the canonical cluster.
    let (code, retired) = call(
        &daemon.socket,
        "/v2/views/drilldown",
        json!({ "id": original }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{retired}");
    let result = &retired["result"];
    assert_eq!(result["found"], true);
    assert_eq!(result["entityType"], "memory");
    assert_eq!(result["lineage"]["supersededBy"], replacement);
    assert_eq!(result["lineage"]["successorCount"], 1);
    assert_eq!(result["canonicalCluster"]["key"], "topic-shared");
    assert!(
        result["canonicalCluster"]["members"]
            .as_array()
            .expect("members")
            .len()
            >= 2
    );

    // The replacement reports the predecessor it superseded.
    let (_, active) = call(
        &daemon.socket,
        "/v2/views/drilldown",
        json!({ "id": replacement }),
        Some(&store_id),
    )
    .await;
    let predecessors = active["result"]["lineage"]["predecessors"]
        .as_array()
        .expect("predecessors");
    assert_eq!(predecessors[0]["id"], original);

    // The graph is internally consistent: every edge names existing nodes.
    let graph = &retired["result"]["graph"];
    let nodes = graph["nodes"].as_array().expect("nodes");
    let node_ids: Vec<&str> = nodes
        .iter()
        .filter_map(|node| node["id"].as_str())
        .collect();
    assert!(node_ids.contains(&original.as_str()));
    assert!(node_ids.contains(&replacement.as_str()));
    let edges = graph["edges"].as_array().expect("edges");
    assert!(!edges.is_empty());
    for edge in edges {
        let source = edge["source"].as_str().unwrap_or("");
        let target = edge["target"].as_str().unwrap_or("");
        assert!(
            node_ids.contains(&source),
            "edge source {source} has a node"
        );
        assert!(
            node_ids.contains(&target),
            "edge target {target} has a node"
        );
        assert!(edge["kind"].is_string());
    }
    assert!(
        edges
            .iter()
            .any(|edge| edge["kind"] == "superseded_by" && edge["target"] == replacement),
        "{graph}"
    );

    // A session id resolves through its episode digest when one exists.
    let (code, missing) = call(
        &daemon.socket,
        "/v2/views/drilldown",
        json!({ "id": "no-such-id" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(missing["result"]["found"], false);
}
