//! Gateway security and translation proofs against a fake daemon.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct FakeDaemon {
    _dir: tempfile::TempDir,
    socket: PathBuf,
    stop: Arc<AtomicBool>,
    /// Every request body the daemon received, newest last.
    requests: Arc<Mutex<Vec<String>>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl FakeDaemon {
    /// Everything the fake daemon received for one path, newest first.
    fn requests_for(&self, path: &str) -> Vec<String> {
        let requests = self.requests.lock().expect("requests");
        requests
            .iter()
            .filter(|request| request.contains(path))
            .rev()
            .cloned()
            .collect()
    }
}

impl FakeDaemon {
    fn start() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("fake.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        listener.set_nonblocking(true).expect("nonblocking");
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for = Arc::clone(&stop);
        let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let requests_for_thread = Arc::clone(&requests);
        let handle = std::thread::spawn(move || {
            while !stop_for.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut buffer = [0u8; 8192];
                        let read = stream.read(&mut buffer).unwrap_or(0);
                        let request_line = String::from_utf8_lossy(&buffer[..read]);
                        requests_for_thread
                            .lock()
                            .expect("requests")
                            .push(request_line.to_string());
                        let status_body = r#"{"ok":true,"requestId":"r","storeId":"store-1","result":{"readiness":"ready","capabilities":["views.read"]}}"#;
                        let bodies = requests_for_thread.lock().expect("requests");
                        let memories_seen = bodies
                            .iter()
                            .filter(|request| {
                                request.contains("/v2/views/memories")
                                    && !request.contains("/v2/views/memories/filters")
                            })
                            .count();
                        let (status, body) = if request_line.contains("/v2/status") {
                            ("200 OK", status_body)
                        } else if request_line.contains("/v2/views/memories")
                            && !request_line.contains("/v2/views/memories/filters")
                            && memories_seen == 1
                        {
                            // First view request answers a store mismatch.
                            (
                                "409 CONFLICT",
                                r#"{"ok":false,"requestId":"r","storeId":"s","error":{"code":"PRECONDITION_FAILED","message":"request rejected","reason":"STORE_ID_MISMATCH","retryable":false}}"#,
                            )
                        } else if request_line.contains("/v2/views/memories/filters") {
                            (
                                "200 OK",
                                r#"{"ok":true,"requestId":"r","storeId":"s","result":{"kinds":[{"kind":"note","count":2}],"scopes":[{"scope":"global","count":2}],"repositories":[{"repository":"acme/app","count":1}]}}"#,
                            )
                        } else if request_line.contains("/v2/views/memories") {
                            (
                                "200 OK",
                                r#"{"ok":true,"requestId":"r","storeId":"s","result":{"items":[{"id":"mem-1","kind":"note","content":"Parity row.","scope":"global","repository":null,"authority":"manual","confidence":1.0,"createdMs":10,"updatedMs":20,"expiresAtMs":null,"sourceSessionId":null,"tags":[]}],"nextCursor":null,"pageSize":25}}"#,
                            )
                        } else if request_line.contains("/v2/views/maintenance") {
                            (
                                "200 OK",
                                r#"{"ok":true,"requestId":"r","storeId":"s","result":{"embeddingJobs":[{"state":"queued","count":3}],"extraction":[],"sources":[]}}"#,
                            )
                        } else if request_line.contains("/v2/views/drilldown") {
                            (
                                "200 OK",
                                r#"{"ok":true,"requestId":"r","storeId":"s","result":{"found":true,"memory":{"id":"mem-1","kind":"note","content":"Parity row.","scope":"global","repository":null,"authority":"manual","confidence":1.0,"createdMs":10,"updatedMs":20,"forgotten":false,"supersededBy":null},"evidence":[{"sourceId":"src-1","generation":"g1","evidenceKey":"e1","role":"user","createdMs":30,"retiredMs":null}],"suppressed":false}}"#,
                            )
                        } else if request_line.contains("/v2/views/health") {
                            (
                                "200 OK",
                                r#"{"ok":true,"requestId":"r","storeId":"s","result":{"schemaVersion":7,"ftsHealthy":true,"ftsRows":2,"migrationState":null,"ready":true}}"#,
                            )
                        } else {
                            (
                                "200 OK",
                                r#"{"ok":true,"requestId":"r","storeId":"s","result":{"storeId":"s","schemaVersion":7,"memoryRevision":"4","derivedGeneration":"0","activeMemories":1,"forgottenMemories":0,"repositories":[],"kinds":[{"kind":"note","count":1}],"sources":{"total":0,"caughtUp":0},"pendingExtraction":0}}"#,
                            )
                        };
                        let response = format!(
                            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        });
        Self {
            _dir: dir,
            socket,
            stop,
            requests,
            handle: Some(handle),
        }
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

struct Gateway {
    child: Child,
    port: u16,
}

impl Gateway {
    fn start(socket: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_lore"))
            .args([
                "--socket",
                socket.to_str().expect("utf8"),
                "browser",
                "--port",
                "0",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn gateway");
        let stdout = child.stdout.take().expect("stdout");
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).expect("read url");
        let port = line
            .trim()
            .rsplit(':')
            .next()
            .and_then(|value| value.trim_end_matches('/').parse::<u16>().ok())
            .unwrap_or_else(|| panic!("unexpected gateway url: {line:?}"));
        Self { child, port }
    }

    fn request(&self, raw: &str) -> (u16, String, String) {
        let address = ("127.0.0.1", self.port)
            .to_socket_addrs()
            .expect("addr")
            .next()
            .expect("addr");
        let mut stream =
            TcpStream::connect_timeout(&address, Duration::from_secs(5)).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        stream.write_all(raw.as_bytes()).expect("write");
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        let (headers, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
        let status = headers
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(0);
        (status, headers.to_string(), body.to_string())
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn wait_for_gateway(socket: &std::path::Path) -> Gateway {
    let started = Instant::now();
    loop {
        let gateway = Gateway::start(socket);
        let (status, _, _) = gateway.request(&format!(
            "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            gateway.port
        ));
        if status == 200 || started.elapsed() > Duration::from_secs(10) {
            return gateway;
        }
    }
}

#[test]
fn gateway_serves_assets_and_translates_views() {
    let daemon = FakeDaemon::start();
    let gateway = wait_for_gateway(&daemon.socket);
    let host = format!("127.0.0.1:{}", gateway.port);

    let (status, headers, body) = gateway.request(&format!(
        "GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200, "{body}");
    assert!(headers.to_lowercase().contains("content-security-policy"));
    assert!(
        headers
            .to_lowercase()
            .contains("x-content-type-options: nosniff")
    );
    assert!(body.contains("<html"), "{body}");

    let (status, headers, body) = gateway.request(&format!(
        "GET /api/overview HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200, "{body}");
    assert!(headers.to_lowercase().contains("cache-control: no-store"));
    assert!(body.contains("\"data\""), "{body}");
    // Translated into the v1 dashboard field names.
    assert!(body.contains("semanticCount"), "{body}");
    assert!(body.contains("latencyTrend"), "{body}");
    assert!(body.contains("indexing"), "{body}");

    let (status, _, body) = gateway.request(&format!(
        "GET /api/memories?page=1&pageSize=25&state=active HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"rows\""), "{body}");
    assert!(body.contains("\"type\":\"note\""), "{body}");
    assert!(body.contains("\"updatedAt\":"), "{body}");
    assert!(body.contains("\"canonicalKey\":null"), "{body}");

    let (status, _, body) = gateway.request(&format!(
        "GET /api/memories/filters HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"types\""), "{body}");
    assert!(body.contains("\"canonicalKeys\":[]"), "{body}");

    let (status, _, body) = gateway.request(&format!(
        "GET /api/maintenance HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("maintenancePlan"), "{body}");
    assert!(body.contains("embedding_jobs:queued"), "{body}");

    let (status, _, body) = gateway.request(&format!(
        "GET /api/drilldown?entity=memory&id=mem-1 HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"entityType\":\"memory\""), "{body}");
    assert!(body.contains("\"focus\""), "{body}");
    assert!(body.contains("\"provenance\""), "{body}");
    assert!(body.contains("\"graph\""), "{body}");

    let (status, _, body) = gateway.request(&format!(
        "GET /api/health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"ok\":true"), "{body}");
    assert!(body.contains("\"loreCliPath\":null"), "{body}");
}

#[test]
fn gateway_negotiates_the_store_identity_before_reading_views() {
    let daemon = FakeDaemon::start();
    let gateway = wait_for_gateway(&daemon.socket);
    let host = format!("127.0.0.1:{}", gateway.port);

    // The gateway cannot know the store id without asking; it must fetch
    // Status first and then present that identity on the view request.
    let (status, _, body) = gateway.request(&format!(
        "GET /api/overview HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200, "{body}");
    let status_requests = daemon.requests_for("/v2/status");
    assert!(
        !status_requests.is_empty(),
        "the gateway probes Status first"
    );
    let view_requests = daemon.requests_for("/v2/views/overview");
    assert_eq!(view_requests.len(), 1, "one view request per page load");
    assert!(
        view_requests[0].contains("\"expectedStoreId\":\"store-1\""),
        "{}",
        view_requests[0]
    );
}

#[test]
fn same_origin_origin_headers_are_allowed_and_favicon_is_quiet() {
    let daemon = FakeDaemon::start();
    let gateway = wait_for_gateway(&daemon.socket);
    let host = format!("127.0.0.1:{}", gateway.port);

    // A browser may attach Origin to a same-origin subresource request.
    let (status, _, body) = gateway.request(&format!(
        "GET /app.js HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200, "same-origin must not be refused: {body}");

    // A genuinely cross-origin request is still refused.
    let (status, _, _) = gateway.request(&format!(
        "GET /app.js HTTP/1.1\r\nHost: {host}\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 403);

    // Favicon requests answer cleanly instead of 404.
    let (status, _, _) = gateway.request(&format!(
        "GET /favicon.ico HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 204);
}

#[test]
fn gateway_refreshes_the_identity_once_when_the_daemon_changed() {
    // The first view request answers STORE_ID_MISMATCH; the gateway must
    // re-probe Status and retry exactly once, then reuse the identity.
    let daemon = FakeDaemon::start();
    let gateway = wait_for_gateway(&daemon.socket);
    let host = format!("127.0.0.1:{}", gateway.port);

    let (status, _, body) = gateway.request(&format!(
        "GET /api/memories HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200, "{body}");
    // One probe to negotiate, one to refresh after the mismatch.
    assert_eq!(
        daemon.requests_for("/v2/status").len(),
        2,
        "mismatch triggers exactly one refresh"
    );
    // The mismatch reply is not served to the browser; the retry is.
    let view_requests = daemon.requests_for("/v2/views/memories");
    assert_eq!(view_requests.len(), 2, "the rejected attempt is retried");
    assert!(
        view_requests
            .iter()
            .all(|request| { request.contains("\"expectedStoreId\":\"store-1\"") }),
        "{}",
        view_requests[0]
    );

    // After the refresh the identity is cached: no further probes.
    let (status, _, _) = gateway.request(&format!(
        "GET /api/memories HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 200);
    assert_eq!(daemon.requests_for("/v2/status").len(), 2);
}

#[test]
fn gateway_rejects_cross_origin_and_bad_hosts() {
    let daemon = FakeDaemon::start();
    let gateway = wait_for_gateway(&daemon.socket);

    let (status, _, _) = gateway
        .request("GET /api/overview HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
    assert_eq!(status, 403);

    let (status, _, _) = gateway.request(&format!(
        "GET /api/overview HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n",
        gateway.port
    ));
    assert_eq!(status, 403);
}

#[test]
fn gateway_is_read_only_and_has_no_traversal_or_unknown_routes() {
    let daemon = FakeDaemon::start();
    let gateway = wait_for_gateway(&daemon.socket);
    let host = format!("127.0.0.1:{}", gateway.port);

    let (status, _, _) = gateway.request(&format!(
        "POST /api/overview HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 405);

    let (status, _, _) = gateway.request(&format!(
        "GET /api/../etc/passwd HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert!(
        status == 404 || status == 400,
        "traversal must not resolve: {status}"
    );

    let (status, _, _) = gateway.request(&format!(
        "GET /api/not-a-view HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 404);

    let (status, _, _) = gateway.request(&format!(
        "GET /../browser/../etc/passwd HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    ));
    assert_eq!(status, 404);
}
