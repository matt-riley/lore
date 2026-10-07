//! Gateway security and translation proofs against a fake daemon.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

struct FakeDaemon {
    _dir: tempfile::TempDir,
    socket: PathBuf,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl FakeDaemon {
    fn start() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("fake.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        listener.set_nonblocking(true).expect("nonblocking");
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            while !stop_for.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut buffer = [0u8; 8192];
                        let _ = stream.read(&mut buffer);
                        let body = r#"{"ok":true,"requestId":"r","storeId":"s","result":{"activeMemories":1}}"#;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
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
    assert!(body.contains("activeMemories"), "{body}");
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
