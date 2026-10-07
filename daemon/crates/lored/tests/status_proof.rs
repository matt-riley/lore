//! G1 proof: `lored`'s Status route over a real Unix socket.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use protocol::{RequestMeta, StatusParams};

struct Daemon {
    child: Child,
    socket: PathBuf,
    _dir: tempfile::TempDir,
}

impl Daemon {
    fn start() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("lored.sock");
        let child = Command::new(env!("CARGO_BIN_EXE_lored"))
            .arg("--socket")
            .arg(&socket)
            .arg("--store-id")
            .arg("store-test")
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

    fn socket(&self) -> &Path {
        &self.socket
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn wait_for_socket(path: &Path) {
    for _ in 0..500 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("socket {} did not appear", path.display());
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

async fn raw(
    socket: &Path,
    method: &str,
    path: &str,
    host: &str,
    content_type: &str,
    body: &str,
) -> (u16, String) {
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::Request;
    use hyper_util::rt::TokioIo;

    let stream = tokio::net::UnixStream::connect(socket)
        .await
        .expect("connect");
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .expect("handshake");
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let request = Request::builder()
        .method(method)
        .uri(format!("http://{host}{path}"))
        .header(hyper::header::HOST, host)
        .header(hyper::header::CONTENT_TYPE, content_type)
        .body(Full::new(Bytes::from(body.to_string())))
        .expect("request");
    let response = sender.send_request(request).await.expect("send");
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn reason(body: &str) -> String {
    let json: serde_json::Value = serde_json::from_str(body).expect("error body is json");
    json["error"]["reason"]
        .as_str()
        .expect("error reason is a string")
        .to_string()
}

#[tokio::test]
async fn status_round_trip_is_contract_shaped() {
    let daemon = Daemon::start();
    wait_for_socket(daemon.socket()).await;
    let outcome = lore::request_status(daemon.socket(), meta(), StatusParams::default())
        .await
        .expect("status");
    assert_eq!(outcome.status_code, 200, "body: {}", outcome.body);
    let json = outcome.json().expect("json");
    assert_eq!(json["ok"], true);
    assert_eq!(json["storeId"], "store-test");
    assert_eq!(json["result"]["apiMajor"], 2);
    assert_eq!(json["result"]["apiMinor"], 0);
    assert_eq!(json["result"]["schemaVersion"], 1);
    assert_eq!(json["result"]["readiness"], "ready");
    assert!(json["result"]["uptimeMs"].as_u64().is_some());
    let capabilities = json["result"]["capabilities"]
        .as_array()
        .expect("capabilities");
    assert!(capabilities.iter().any(|value| value == "status.basic"));
}

#[tokio::test]
async fn sequential_requests_reconnect_cleanly() {
    let daemon = Daemon::start();
    wait_for_socket(daemon.socket()).await;
    for _ in 0..3 {
        let outcome = lore::request_status(daemon.socket(), meta(), StatusParams::default())
            .await
            .expect("status");
        assert_eq!(outcome.status_code, 200);
    }
}

#[tokio::test]
async fn rejects_foreign_host_header() {
    let daemon = Daemon::start();
    wait_for_socket(daemon.socket()).await;
    let (status, body) = raw(
        daemon.socket(),
        "POST",
        "/v2/status",
        "localhost",
        "application/json",
        r#"{"meta":{"clientId":"t","requestId":"r"}}"#,
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(reason(&body), "INVALID_HOST");
}

#[tokio::test]
async fn unknown_route_is_unimplemented() {
    let daemon = Daemon::start();
    wait_for_socket(daemon.socket()).await;
    let (status, body) = raw(
        daemon.socket(),
        "POST",
        "/v2/retain",
        "lore.local",
        "application/json",
        r#"{"meta":{"clientId":"t","requestId":"r"}}"#,
    )
    .await;
    assert_eq!(status, 501);
    assert_eq!(reason(&body), "ROUTE_UNIMPLEMENTED");
}

#[tokio::test]
async fn invalid_json_content_type_and_method_are_rejected() {
    let daemon = Daemon::start();
    wait_for_socket(daemon.socket()).await;

    let (status, body) = raw(
        daemon.socket(),
        "POST",
        "/v2/status",
        "lore.local",
        "application/json",
        "not json",
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(reason(&body), "INVALID_JSON");

    let (status, body) = raw(
        daemon.socket(),
        "POST",
        "/v2/status",
        "lore.local",
        "text/plain",
        "{}",
    )
    .await;
    assert_eq!(status, 415);
    assert_eq!(reason(&body), "UNSUPPORTED_MEDIA_TYPE");

    let (status, body) = raw(
        daemon.socket(),
        "GET",
        "/v2/status",
        "lore.local",
        "application/json",
        "",
    )
    .await;
    assert_eq!(status, 405);
    assert_eq!(reason(&body), "METHOD_NOT_ALLOWED");
}

#[tokio::test]
async fn mismatched_store_and_major_are_failed_preconditions() {
    let daemon = Daemon::start();
    wait_for_socket(daemon.socket()).await;

    let mut wrong_store = meta();
    wrong_store.expected_store_id = Some("other-store".to_string());
    let outcome = lore::request_status(daemon.socket(), wrong_store, StatusParams::default())
        .await
        .expect("status");
    assert_eq!(outcome.status_code, 412);
    assert_eq!(reason(&outcome.body), "STORE_MISMATCH");

    let outcome = lore::request_status(
        daemon.socket(),
        meta(),
        StatusParams {
            expected_api_major: Some(3),
        },
    )
    .await
    .expect("status");
    assert_eq!(outcome.status_code, 412);
    assert_eq!(reason(&outcome.body), "API_MAJOR_MISMATCH");
}

#[tokio::test]
async fn zero_deadline_is_rejected() {
    let daemon = Daemon::start();
    wait_for_socket(daemon.socket()).await;

    let mut zero = meta();
    zero.timeout_ms = Some(0);
    let outcome = lore::request_status(daemon.socket(), zero, StatusParams::default())
        .await
        .expect("status");
    assert_eq!(outcome.status_code, 400);
    assert_eq!(reason(&outcome.body), "INVALID_DEADLINE");
}
