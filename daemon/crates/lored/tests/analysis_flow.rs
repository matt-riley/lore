//! Optional analysis lane: bounded, in-memory-only augmentation against a
//! fake chat endpoint. The daemon must refetch and revalidate every record it
//! submits, keep one chat lane, and never mutate the store.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use protocol::RequestMeta;
use serde_json::{Value, json};

/// Scripted chat endpoint: replies with a fixed assistant content and logs
/// every prompt it receives.
struct FakeChat {
    port: u16,
    prompts: Arc<Mutex<Vec<String>>>,
}

impl FakeChat {
    fn start(reply: Value, delay_ms: u64) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind chat");
        let port = listener.local_addr().expect("addr").port();
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let prompts_for_thread = Arc::clone(&prompts);
        let reply_text = serde_json::to_string(&reply).expect("reply");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 4096];
                // Read headers, then the declared content length.
                let mut content_length = 0usize;
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(read) => {
                            buffer.extend_from_slice(&chunk[..read]);
                            if let Some(position) = find_double_crlf(&buffer) {
                                let headers = String::from_utf8_lossy(&buffer[..position]);
                                content_length = headers
                                    .lines()
                                    .find_map(|line| {
                                        let (name, value) = line.split_once(':')?;
                                        if name.eq_ignore_ascii_case("content-length") {
                                            value.trim().parse::<usize>().ok()
                                        } else {
                                            None
                                        }
                                    })
                                    .unwrap_or(0);
                                if buffer.len() >= position + 4 + content_length {
                                    break;
                                }
                            } else if buffer.len() > 2 * 1024 * 1024 {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let body_start = find_double_crlf(&buffer)
                    .map(|position| position + 4)
                    .unwrap_or(0);
                let body_end = (body_start + content_length).min(buffer.len());
                let body = String::from_utf8_lossy(&buffer[body_start..body_end]).to_string();
                prompts_for_thread.lock().expect("prompts").push(body);
                if delay_ms > 0 {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                }
                let envelope = json!({
                    "choices": [{ "message": { "content": reply_text } }]
                });
                let payload = serde_json::to_vec(&envelope).expect("payload");
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(&payload);
                let _ = stream.flush();
            }
        });
        Self { port, prompts }
    }

    /// Reply selected per prompt by a closure.
    fn start_dynamic(reply: impl Fn(&str) -> Value + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind chat");
        let port = listener.local_addr().expect("addr").port();
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let prompts_for_thread = Arc::clone(&prompts);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 4096];
                let mut content_length = 0usize;
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(read) => {
                            buffer.extend_from_slice(&chunk[..read]);
                            if let Some(position) = find_double_crlf(&buffer) {
                                let headers = String::from_utf8_lossy(&buffer[..position]);
                                content_length = headers
                                    .lines()
                                    .find_map(|line| {
                                        let (name, value) = line.split_once(':')?;
                                        if name.eq_ignore_ascii_case("content-length") {
                                            value.trim().parse::<usize>().ok()
                                        } else {
                                            None
                                        }
                                    })
                                    .unwrap_or(0);
                                if buffer.len() >= position + 4 + content_length {
                                    break;
                                }
                            } else if buffer.len() > 2 * 1024 * 1024 {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let body_start = find_double_crlf(&buffer)
                    .map(|position| position + 4)
                    .unwrap_or(0);
                let body_end = (body_start + content_length).min(buffer.len());
                let body = String::from_utf8_lossy(&buffer[body_start..body_end]).to_string();
                prompts_for_thread
                    .lock()
                    .expect("prompts")
                    .push(body.clone());
                let reply_text = serde_json::to_string(&reply(&body)).expect("reply");
                let envelope = json!({
                    "choices": [{ "message": { "content": reply_text } }]
                });
                let payload = serde_json::to_vec(&envelope).expect("payload");
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(&payload);
                let _ = stream.flush();
            }
        });
        Self { port, prompts }
    }

    fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn prompts(&self) -> Vec<String> {
        self.prompts.lock().expect("prompts").clone()
    }
}

fn find_double_crlf(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

struct Daemon {
    child: Child,
    socket: PathBuf,
    _dir: tempfile::TempDir,
    database_path: PathBuf,
}

impl Daemon {
    fn start(analysis: Option<Value>) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("lored.sock");
        let config_path = dir.path().join("lore.json");
        let mut config = json!({
            "configVersion": 2,
            "enabled": true,
            "dataDir": dir.path().to_str().expect("utf8"),
            "socketPath": socket.to_str().expect("utf8"),
        });
        if let Some(analysis) = analysis {
            config["analysis"] = analysis;
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
        let database_path = dir.path().join("lore-v2.db");
        Self {
            child,
            socket,
            _dir: dir,
            database_path,
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
        client_id: "test.rust.analysis".to_string(),
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
async fn analysis_is_unavailable_until_explicitly_enabled() {
    let daemon = Daemon::start(None);
    let store_id = store_id(&daemon.socket).await;
    let (code, body) = call(
        &daemon.socket,
        "/v2/analysis",
        json!({ "kind": "query-expansion", "query": "prefer small functions" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 501, "{body}");
    assert_eq!(body["error"]["reason"], "ANALYSIS_UNAVAILABLE");
}

#[tokio::test]
async fn query_expansion_returns_bounded_terms_without_touching_the_store() {
    let chat = FakeChat::start(json!({ "terms": ["pure functions", "small units"] }), 0);
    let daemon = Daemon::start(Some(json!({
        "enabled": true,
        "endpoint": chat.endpoint(),
        "model": "fake-chat"
    })));
    let store_id = store_id(&daemon.socket).await;
    let (_, before) = call(&daemon.socket, "/v2/status", json!({}), Some(&store_id)).await;

    let (code, body) = call(
        &daemon.socket,
        "/v2/analysis",
        json!({ "kind": "query-expansion", "query": "prefer small pure functions" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["result"]["terms"][0], "pure functions");
    assert_eq!(body["result"]["diagnostics"]["recordsUsed"], 0);
    assert_eq!(body["result"]["diagnostics"]["provider"], "loopback");

    // In-memory only: no durable run, no store mutation.
    let (_, after) = call(&daemon.socket, "/v2/status", json!({}), Some(&store_id)).await;
    assert_eq!(
        before["result"]["memoryRevision"],
        after["result"]["memoryRevision"]
    );
    let runs: i64 = {
        let connection = rusqlite::Connection::open(&daemon.database_path).expect("db");
        connection
            .query_row("SELECT COUNT(*) FROM operation_runs", [], |row| row.get(0))
            .expect("count")
    };
    assert_eq!(runs, 0, "analysis has no durable run");
}

#[tokio::test]
async fn compression_revalidates_selected_records() {
    let reply = Arc::new(Mutex::new(json!({ "sections": [] })));
    let reply_for_server = Arc::clone(&reply);
    let flexible =
        FakeChat::start_dynamic(move |_prompt| reply_for_server.lock().expect("reply").clone());
    let daemon = Daemon::start(Some(json!({
        "enabled": true,
        "endpoint": flexible.endpoint(),
        "model": "fake-chat"
    })));
    let store_id = store_id(&daemon.socket).await;
    let keep = retain(
        &daemon.socket,
        &store_id,
        "analysis-keep",
        "Kept content that must be submitted.",
    )
    .await;
    let other = retain(
        &daemon.socket,
        &store_id,
        "analysis-other",
        "Second kept content.",
    )
    .await;
    // Memory revisions are store-wide, so read the real ones back.
    let (keep_revision, other_revision) = {
        let connection = rusqlite::Connection::open(&daemon.database_path).expect("db");
        let revision = |id: &str| -> i64 {
            connection
                .query_row(
                    "SELECT revision FROM memories WHERE id = ?1",
                    rusqlite::params![id],
                    |row| row.get(0),
                )
                .expect("revision")
        };
        (revision(&keep), revision(&other))
    };

    *reply.lock().expect("reply") = json!({
        "sections": [
            { "id": keep, "text": "compressed keep" },
            { "id": other, "text": "compressed other" }
        ]
    });
    let (code, body) = call(
        &daemon.socket,
        "/v2/analysis",
        json!({
            "kind": "context-compression",
            "query": "what did we decide",
            "records": [
                { "id": keep, "revision": keep_revision },
                { "id": other, "revision": other_revision },
                { "id": "mem_does_not_exist", "revision": keep_revision }
            ]
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(
        body["result"]["sections"]
            .as_array()
            .expect("sections")
            .len(),
        2
    );
    assert_eq!(body["result"]["diagnostics"]["recordsUsed"], 2);
    assert_eq!(body["result"]["diagnostics"]["recordsDropped"], 1);

    // A stale revision is dropped; with no valid records the model is not
    // called at all and the response is an explicit empty result.
    *reply.lock().expect("reply") = json!({ "sections": [{ "id": keep, "text": "only keep" }] });
    let prompts_before = flexible.prompts().len();
    let (code, body) = call(
        &daemon.socket,
        "/v2/analysis",
        json!({
            "kind": "context-compression",
            "query": "what did we decide",
            "records": [{ "id": keep, "revision": keep_revision + 999 }]
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["result"]["diagnostics"]["recordsUsed"], 0);
    assert_eq!(body["result"]["diagnostics"]["recordsDropped"], 1);
    assert_eq!(body["result"]["diagnostics"]["provider"], "skipped");
    assert!(
        body["result"]["sections"]
            .as_array()
            .expect("sections")
            .is_empty()
    );
    assert_eq!(
        flexible.prompts().len(),
        prompts_before,
        "no model call for an empty selection"
    );

    // A model that invents an id is rejected, not trusted.
    *reply.lock().expect("reply") = json!({
        "sections": [{ "id": "mem_invented", "text": "fabricated" }]
    });
    let (code, body) = call(
        &daemon.socket,
        "/v2/analysis",
        json!({
            "kind": "context-compression",
            "query": "what did we decide",
            "records": [{ "id": keep, "revision": keep_revision }]
        }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 502, "{body}");
    assert_eq!(body["error"]["reason"], "ANALYSIS_INVALID_RESPONSE");

    // The submitted prompt contained the real content only.
    let prompts = flexible.prompts();
    let combined = prompts.join("\n");
    assert!(combined.contains("Kept content that must be submitted."));
}

#[tokio::test]
async fn analysis_rejects_bad_input_and_keeps_one_chat_lane() {
    let chat = FakeChat::start(json!({ "terms": ["slow"] }), 700);
    let daemon = Daemon::start(Some(json!({
        "enabled": true,
        "endpoint": chat.endpoint(),
        "model": "fake-chat"
    })));
    let store_id = store_id(&daemon.socket).await;

    // Oversized query.
    let (code, body) = call(
        &daemon.socket,
        "/v2/analysis",
        json!({ "kind": "query-expansion", "query": "x".repeat(17 * 1024) }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{body}");
    assert_eq!(body["error"]["reason"], "ANALYSIS_QUERY_INVALID");

    // Unknown kind.
    let (code, body) = call(
        &daemon.socket,
        "/v2/analysis",
        json!({ "kind": "summarize", "query": "hello" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{body}");
    assert_eq!(body["error"]["reason"], "ANALYSIS_KIND_INVALID");

    // Compression without records.
    let (code, body) = call(
        &daemon.socket,
        "/v2/analysis",
        json!({ "kind": "context-compression", "query": "hello" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 400, "{body}");
    assert_eq!(body["error"]["reason"], "ANALYSIS_RECORDS_REQUIRED");

    // One chat lane: a second overlapping request is refused, not queued.
    let first = call(
        &daemon.socket,
        "/v2/analysis",
        json!({ "kind": "query-expansion", "query": "first" }),
        Some(&store_id),
    );
    let second = call(
        &daemon.socket,
        "/v2/analysis",
        json!({ "kind": "query-expansion", "query": "second" }),
        Some(&store_id),
    );
    let (first, second) = tokio::join!(first, second);
    let mut codes = [first.0, second.0];
    codes.sort_unstable();
    assert_eq!(codes, [200, 409], "one lane, one refusal");
}
