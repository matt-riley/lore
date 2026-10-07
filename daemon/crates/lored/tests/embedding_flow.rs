//! End-to-end embedding flow against a fake OpenAI-compatible provider:
//! worker indexing, hybrid recall, outage fallback, caching and status.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use protocol::RequestMeta;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone, Copy)]
enum Mode {
    Ok,
    ServerError,
    WrongDimensions,
}

struct FakeProvider {
    endpoint: String,
    requests: Arc<AtomicUsize>,
}

impl FakeProvider {
    async fn start(mode: Mode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let requests = Arc::new(AtomicUsize::new(0));
        let mode = Arc::new(Mutex::new(mode));
        let requests_for = Arc::clone(&requests);
        let mode_for = Arc::clone(&mode);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let requests = Arc::clone(&requests_for);
                let mode = Arc::clone(&mode_for);
                tokio::spawn(async move {
                    let mut buffer = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        let Ok(read) = stream.read(&mut chunk).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        buffer.extend_from_slice(&chunk[..read]);
                        let Some(header_end) =
                            buffer.windows(4).position(|window| window == b"\r\n\r\n")
                        else {
                            continue;
                        };
                        if buffer.len() >= header_end + 4 + content_length(&buffer[..header_end]) {
                            break;
                        }
                    }
                    requests.fetch_add(1, Ordering::SeqCst);
                    let (status, body) = match *mode.lock().expect("mode") {
                        Mode::Ok => (
                            "200",
                            r#"{"data":[{"index":0,"embedding":[1,0,0,0]}]}"#.to_string(),
                        ),
                        Mode::ServerError => ("500", r#"{"error":"boom"}"#.to_string()),
                        Mode::WrongDimensions => (
                            "200",
                            r#"{"data":[{"index":0,"embedding":[1,0]}]}"#.to_string(),
                        ),
                    };
                    let response = format!(
                        "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        Self {
            endpoint: format!("http://127.0.0.1:{port}/v1"),
            requests,
        }
    }
}

fn content_length(headers: &[u8]) -> usize {
    String::from_utf8_lossy(headers)
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0)
}

struct Daemon {
    child: Child,
    socket: PathBuf,
    _dir: tempfile::TempDir,
}

impl Daemon {
    fn start(endpoint: &str) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("lored.sock");
        let config_path = dir.path().join("lore.json");
        let config = json!({
            "configVersion": 2,
            "enabled": true,
            "dataDir": dir.path().to_str().expect("utf8"),
            "socketPath": socket.to_str().expect("utf8"),
            "providers": {
                "embeddings": {
                    "enabled": true,
                    "endpoint": endpoint,
                    "model": "fake-model",
                    "dimensions": 4,
                    "generation": 1,
                    "timeoutMs": 5000,
                    "minSimilarity": 0.5
                }
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
        client_id: "test.rust".to_string(),
        request_id: format!("request-{}", uuid::Uuid::new_v4()),
        session_id: None,
        expected_store_id: None,
        timeout_ms: None,
        required_capabilities: Vec::new(),
    }
}

async fn try_status(socket: &std::path::Path) -> Option<Value> {
    let outcome = lore::request(socket, "/v2/status", meta(), json!({}))
        .await
        .ok()?;
    if outcome.status_code != 200 {
        return None;
    }
    serde_json::from_str(&outcome.body).ok()
}

async fn wait_for_status(socket: &std::path::Path, predicate: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..500 {
        if let Some(value) = try_status(socket).await
            && predicate(&value)
        {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("status condition was not met");
}

async fn retain(socket: &std::path::Path, store_id: &str, key: &str, content: &str) -> Value {
    let mut meta = meta();
    meta.expected_store_id = Some(store_id.to_string());
    let outcome = lore::request(
        socket,
        "/v2/retain",
        meta,
        json!({
            "idempotencyKey": key,
            "type": "note",
            "content": content,
            "scope": "global"
        }),
    )
    .await
    .expect("retain");
    assert_eq!(outcome.status_code, 200, "body: {}", outcome.body);
    serde_json::from_str(&outcome.body).expect("json")
}

async fn recall(socket: &std::path::Path, store_id: &str, query: &str) -> Value {
    let mut meta = meta();
    meta.expected_store_id = Some(store_id.to_string());
    let outcome = lore::request(socket, "/v2/recall", meta, json!({ "query": query }))
        .await
        .expect("recall");
    assert_eq!(outcome.status_code, 200, "body: {}", outcome.body);
    serde_json::from_str(&outcome.body).expect("json")
}

#[tokio::test]
async fn worker_indexes_and_vector_recall_finds_lexically_unrelated_memory() {
    let provider = FakeProvider::start(Mode::Ok).await;
    let daemon = Daemon::start(&provider.endpoint);
    let initial = wait_for_status(&daemon.socket, |_| true).await;
    let store_id = initial["storeId"].as_str().expect("storeId").to_string();

    retain(&daemon.socket, &store_id, "v1", "vector payload alpha").await;
    wait_for_status(&daemon.socket, |value| {
        value["result"]["embedding"]["coverageCurrent"] == "1"
    })
    .await;

    let result = recall(&daemon.socket, &store_id, "zzz unrelated probe").await;
    let records = result["result"]["records"].as_array().expect("records");
    assert_eq!(records.len(), 1, "the vector path found the memory");
    assert_eq!(result["result"]["diagnostics"]["retrievalMode"], "hybrid");
    assert_eq!(result["result"]["diagnostics"]["vectorContribution"], 1);
    assert_eq!(result["result"]["diagnostics"]["fallbackReason"], "NONE");
}

#[tokio::test]
async fn provider_outage_falls_back_to_lexical_with_a_reason() {
    let provider = FakeProvider::start(Mode::ServerError).await;
    let daemon = Daemon::start(&provider.endpoint);
    let initial = wait_for_status(&daemon.socket, |_| true).await;
    let store_id = initial["storeId"].as_str().expect("storeId").to_string();

    retain(&daemon.socket, &store_id, "v1", "lexical anchor phrase").await;
    let result = recall(&daemon.socket, &store_id, "lexical anchor phrase").await;
    assert_eq!(
        result["result"]["records"]
            .as_array()
            .expect("records")
            .len(),
        1
    );
    assert_eq!(result["result"]["diagnostics"]["retrievalMode"], "lexical");
    assert_eq!(
        result["result"]["diagnostics"]["fallbackReason"],
        "PROVIDER_OFFLINE"
    );

    let unrelated = recall(&daemon.socket, &store_id, "zzz unrelated probe").await;
    assert_eq!(
        unrelated["result"]["records"]
            .as_array()
            .expect("records")
            .len(),
        0,
        "no vectors exist during the outage"
    );
}

#[tokio::test]
async fn identical_queries_are_served_from_the_cache() {
    let provider = FakeProvider::start(Mode::Ok).await;
    let daemon = Daemon::start(&provider.endpoint);
    let initial = wait_for_status(&daemon.socket, |_| true).await;
    let store_id = initial["storeId"].as_str().expect("storeId").to_string();

    retain(&daemon.socket, &store_id, "v1", "cache probe memory").await;
    wait_for_status(&daemon.socket, |value| {
        value["result"]["embedding"]["coverageCurrent"] == "1"
    })
    .await;

    let first = recall(&daemon.socket, &store_id, "unique cache probe query").await;
    assert_eq!(first["result"]["diagnostics"]["cache"], "miss");
    let after_first = provider.requests.load(Ordering::SeqCst);

    let second = recall(&daemon.socket, &store_id, "unique cache probe query").await;
    assert_eq!(second["result"]["diagnostics"]["cache"], "hit");
    assert_eq!(
        provider.requests.load(Ordering::SeqCst),
        after_first,
        "a cache hit performs no provider call"
    );
}

#[tokio::test]
async fn malformed_provider_falls_back_and_records_a_terminal_failure() {
    let provider = FakeProvider::start(Mode::WrongDimensions).await;
    let daemon = Daemon::start(&provider.endpoint);
    let initial = wait_for_status(&daemon.socket, |_| true).await;
    let store_id = initial["storeId"].as_str().expect("storeId").to_string();

    retain(&daemon.socket, &store_id, "v1", "malformed provider fact").await;
    let result = recall(&daemon.socket, &store_id, "malformed provider fact").await;
    assert_eq!(result["result"]["diagnostics"]["retrievalMode"], "lexical");
    assert_eq!(
        result["result"]["diagnostics"]["fallbackReason"],
        "PROVIDER_DIMENSIONS"
    );

    let status = wait_for_status(&daemon.socket, |value| {
        value["result"]["embedding"]["failed"].as_str() != Some("0")
    })
    .await;
    assert_eq!(status["result"]["embedding"]["state"], "invalid");
}

#[tokio::test]
async fn embedding_status_and_jobs_routes_report_coverage() {
    let provider = FakeProvider::start(Mode::Ok).await;
    let daemon = Daemon::start(&provider.endpoint);
    let initial = wait_for_status(&daemon.socket, |_| true).await;
    let store_id = initial["storeId"].as_str().expect("storeId").to_string();

    retain(&daemon.socket, &store_id, "v1", "status route fact").await;
    let status = wait_for_status(&daemon.socket, |value| {
        value["result"]["embedding"]["coverageCurrent"] == "1"
    })
    .await;
    assert_eq!(status["result"]["embedding"]["state"], "ready");
    assert_eq!(status["result"]["embedding"]["dimensions"], 4);
    assert_eq!(status["result"]["embedding"]["coverageEligible"], "1");

    let mut request_meta = meta();
    request_meta.expected_store_id = Some(store_id.clone());
    let jobs = lore::request(&daemon.socket, "/v2/jobs/status", request_meta, json!({}))
        .await
        .expect("jobs");
    assert_eq!(jobs.status_code, 200, "body: {}", jobs.body);
    let jobs: Value = serde_json::from_str(&jobs.body).expect("json");
    assert_eq!(jobs["result"]["counts"]["failed"], "0");

    let mut request_meta = meta();
    request_meta.expected_store_id = Some(store_id);
    let reload = lore::request(
        &daemon.socket,
        "/v2/config/reload",
        request_meta,
        json!({ "idempotencyKey": "reload-1" }),
    )
    .await
    .expect("reload");
    assert_eq!(reload.status_code, 200, "body: {}", reload.body);
    let reload: Value = serde_json::from_str(&reload.body).expect("json");
    assert_eq!(reload["result"]["reloaded"], false);
    assert_eq!(reload["result"]["reason"], "UNCHANGED");
}
