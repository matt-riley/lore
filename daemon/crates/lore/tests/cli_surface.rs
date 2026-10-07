//! CLI surface proofs: capability catalog, planned-operation failures, native
//! hook translation and neutral failure against a fake daemon.

use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn run_cli(args: &[&str], stdin: Option<&str>) -> (i32, String, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lore"));
    command.args(args);
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().expect("spawn lore");
    if let Some(stdin) = stdin {
        child
            .stdin
            .as_mut()
            .expect("stdin")
            .write_all(stdin.as_bytes())
            .expect("write stdin");
    }
    let output = child.wait_with_output().expect("wait");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

/// Fake daemon over a Unix socket, serving one canned body per request.
fn fake_daemon(bodies: Vec<String>) -> (PathBuf, tempfile::TempDir, std::thread::JoinHandle<()>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let socket = dir.path().join("fake.sock");
    let listener = UnixListener::bind(&socket).expect("bind");
    listener.set_nonblocking(true).expect("nonblocking");
    let handle = std::thread::spawn(move || {
        for body in bodies {
            let started = Instant::now();
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if started.elapsed() > Duration::from_secs(5) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("accept: {error}"),
                }
            };
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let read = stream.read(&mut chunk).expect("read");
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
                if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (socket, dir, handle)
}

#[test]
fn capability_catalog_is_served_without_a_daemon() {
    let (code, stdout, _) = run_cli(&["capabilities", "--output", "json"], None);
    assert_eq!(code, 0);
    let rows: Vec<serde_json::Value> = serde_json::from_str(&stdout).expect("json");
    assert_eq!(rows.len(), 27);
    assert!(rows.iter().all(|row| row["support"].is_string()));
}

#[test]
fn capability_inventory_works_without_a_daemon() {
    let (code, stdout, stderr) = run_cli(
        &[
            "--socket",
            "/tmp/lore-missing.sock",
            "tool",
            "memory_capability_inventory",
            "--output",
            "json",
        ],
        Some("{}"),
    );
    assert_eq!(code, 0, "{stdout} {stderr}");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("json");
    assert_eq!(value["rows"].as_array().expect("rows").len(), 27);
    assert!(value["daemon"]["storeId"].is_null());
}

#[test]
fn search_verb_dispatches_to_the_admin_route() {
    let status = serde_json::json!({
        "ok": true,
        "requestId": "r1",
        "storeId": "s",
        "result": { "capabilities": ["search.browse"] }
    })
    .to_string();
    let search = serde_json::json!({
        "ok": true,
        "requestId": "r2",
        "storeId": "s",
        "result": {
            "items": [{ "id": "mem_1", "kind": "note", "content": "Durable search target", "scope": "Global" }],
            "nextCursor": null
        }
    })
    .to_string();
    let (socket, _dir, handle) = fake_daemon(vec![status, search]);
    let (code, stdout, stderr) = run_cli(
        &[
            "--socket",
            socket.to_str().expect("utf8"),
            "search",
            "durable",
            "--output",
            "json",
        ],
        None,
    );
    handle.join().expect("fake daemon");
    assert_eq!(code, 0, "{stdout} {stderr}");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("json");
    assert_eq!(value["result"]["items"][0]["id"], "mem_1");
}

#[test]
fn planned_operations_fail_before_dispatch() {
    let (code, _, stderr) = run_cli(
        &[
            "--socket",
            "/tmp/does-not-exist.sock",
            "tool",
            "lore_correct",
        ],
        Some("{}"),
    );
    assert_ne!(code, 0);
    assert!(stderr.contains("unimplemented"), "{stderr}");
}

#[test]
fn prompt_hooks_return_context_from_recall() {
    let body = serde_json::json!({
        "ok": true,
        "requestId": "r",
        "storeId": "s",
        "result": { "context": "- Prefer UTC timestamps." }
    })
    .to_string();
    let (socket, _dir, handle) = fake_daemon(vec![body]);
    let (code, stdout, stderr) = run_cli(
        &[
            "--socket",
            socket.to_str().expect("utf8"),
            "hook",
            "codex",
            "UserPromptSubmit",
        ],
        Some(r#"{"prompt":"what timestamps do we prefer?"}"#),
    );
    handle.join().expect("fake daemon");
    assert_eq!(code, 0, "cli failed: {stdout} / {stderr}");
    let value: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|_| panic!("stdout not json: {stdout} / stderr: {stderr}"));
    assert_eq!(
        value["context"], "- Prefer UTC timestamps.",
        "stdout: {stdout} stderr: {stderr}"
    );
}

#[test]
fn hooks_fail_neutral_when_the_daemon_is_missing() {
    let (code, stdout, _) = run_cli(
        &[
            "--socket",
            "/tmp/lore-missing.sock",
            "hook",
            "claude",
            "UserPromptSubmit",
        ],
        Some(r#"{"prompt":"hello"}"#),
    );
    assert_eq!(code, 0, "hooks never fail the host");
    assert_eq!(stdout.trim(), "{}");

    let (code, stdout, _) = run_cli(
        &[
            "--socket",
            "/tmp/lore-missing.sock",
            "hook",
            "antigravity",
            "Stop",
        ],
        Some("{}"),
    );
    assert_eq!(code, 0);
    assert_eq!(stdout.trim(), r#"{"decision":"stop"}"#);
}

#[test]
fn hooks_ignore_non_prompt_events_without_calling_the_daemon() {
    let (code, stdout, _) = run_cli(
        &[
            "--socket",
            "/tmp/lore-missing.sock",
            "hook",
            "codex",
            "PostToolUse",
        ],
        Some(r#"{"tool":"shell"}"#),
    );
    assert_eq!(code, 0);
    assert_eq!(stdout.trim(), "{}");
}
