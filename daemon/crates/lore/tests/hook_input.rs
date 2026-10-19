//! Native hooks must not fail the host when tool output exceeds the input cap.

use std::io::{ErrorKind, Write};
use std::process::{Command, Stdio};

fn hook(client: &str, event: &str, payload: &[u8]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lore"))
        .args([
            "--socket",
            "/tmp/lore-hook-input-missing.sock",
            "hook",
            client,
            event,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hook");
    let mut stdin = child.stdin.take().expect("stdin");
    if let Err(error) = stdin.write_all(payload) {
        assert_eq!(error.kind(), ErrorKind::BrokenPipe, "write hook input");
    }
    drop(stdin);
    child.wait_with_output().expect("hook output")
}

#[test]
fn post_tool_use_stays_neutral_when_tool_output_exceeds_one_mib() {
    let payload = serde_json::json!({ "tool_response": "x".repeat(1024 * 1024) }).to_string();
    let output = hook("codex", "PostToolUse", payload.as_bytes());
    assert!(
        output.status.success(),
        "hooks never fail the host: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "{}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("exceeds"));
}

#[test]
fn input_at_the_limit_is_accepted_without_a_warning() {
    let mut payload = b"{}".to_vec();
    payload.resize(1024 * 1024, b' ');
    let output = hook("codex", "PostToolUse", &payload);
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "{}");
    assert!(output.stderr.is_empty());
}

#[test]
fn invalid_utf8_stays_neutral_and_antigravity_keeps_its_stop_response() {
    for (client, event, expected) in [
        ("codex", "UserPromptSubmit", "{}"),
        ("claude", "UserPromptSubmit", "{}"),
        ("antigravity", "Stop", r#"{"decision":"stop"}"#),
    ] {
        let output = hook(client, event, b"\xff");
        assert!(output.status.success(), "{client}/{event}");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), expected);
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn malformed_input_stays_neutral_for_every_codex_lifecycle_hook() {
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "PostToolUse",
        "PreCompact",
        "Stop",
        "SessionEnd",
    ] {
        let output = hook("codex", event, b"{\"tool_response\":");
        assert!(output.status.success(), "{event} must not fail the host");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "{}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("invalid hook JSON"));
    }
}
