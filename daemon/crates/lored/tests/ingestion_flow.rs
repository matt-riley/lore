//! End-to-end source registration, hinting, discovery and status.

use std::path::Path;
use std::time::Duration;

use protocol::RequestMeta;
use serde_json::{Value, json};

mod support;
use support::Daemon;

fn start() -> Daemon {
    let dir = tempfile::tempdir().expect("tempdir");
    let sources = dir.path().join("sources");
    std::fs::create_dir_all(&sources).expect("sources dir");
    std::fs::write(
        sources.join("session.jsonl"),
        concat!(
            "{\"type\":\"session\",\"id\":\"pi-flow-1\",\"cwd\":\"/work\"}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"What captures transcript evidence?\"}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"The bounded capture quantum commits evidence atomically.\"}}\n"
        ),
    )
    .expect("fixture");
    let mut config = Daemon::config_with(dir.path());
    config["sources"] = json!({
        "roots": [{
            "rootId": "pi-root",
            "client": "pi",
            "path": sources.to_str().expect("utf8")
        }],
        "sweepSeconds": 60
    });
    Daemon::spawn(dir, &config, &[])
}

fn meta() -> RequestMeta {
    RequestMeta {
        client_id: "test.rust.sources".to_string(),
        request_id: format!("request-{}", uuid::Uuid::new_v4()),
        session_id: None,
        expected_store_id: None,
        timeout_ms: None,
        required_capabilities: Vec::new(),
    }
}

async fn store_id(socket: &Path) -> String {
    for _ in 0..500 {
        if let Ok(outcome) = lore::request(socket, "/v2/status", meta(), json!({})).await
            && outcome.status_code == 200
            && let Ok(body) = serde_json::from_str::<Value>(&outcome.body)
            && let Some(store_id) = body["storeId"].as_str()
        {
            return store_id.to_string();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon did not report a store id");
}

async fn call(socket: &Path, route: &str, params: Value) -> (u16, Value) {
    let store = store_id(socket).await;
    for _ in 0..500 {
        let mut meta = meta();
        meta.expected_store_id = Some(store.clone());
        match lore::request(socket, route, meta, params.clone()).await {
            Ok(outcome) => {
                let body = serde_json::from_str::<Value>(&outcome.body).unwrap_or(Value::Null);
                return (outcome.status_code, body);
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    panic!(
        "daemon did not accept requests; stderr:\n{}",
        support::stderr_for(socket)
    );
}

async fn source_status(socket: &Path, include_paths: bool) -> Value {
    let (status, body) = call(
        socket,
        "/v2/sources/status",
        json!({ "limit": 10, "includePaths": include_paths }),
    )
    .await;
    assert_eq!(status, 200, "body: {body}");
    body
}

async fn wait_for_capture(socket: &Path) -> Value {
    for _ in 0..500 {
        let body = source_status(socket, false).await;
        let ready = body["result"]["sources"]
            .as_array()
            .map(|sources| {
                sources.iter().any(|source| {
                    source["state"] == "caught_up"
                        && source["normalizedRecords"].as_i64().unwrap_or(0) >= 3
                })
            })
            .unwrap_or(false);
        if ready {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("capture did not reach caught_up");
}

#[tokio::test]
async fn registration_captures_and_reports_without_exposing_paths() {
    let daemon = start();
    let session = daemon.sources_dir().join("session.jsonl");
    let (status, body) = call(
        &daemon.socket,
        "/v2/sources/register",
        json!({
            "idempotencyKey": "register-1",
            "client": "pi",
            "rootId": "pi-root",
            "path": session.to_str().expect("utf8"),
            "nativeSessionId": "pi-flow-1",
            "repository": "owner/name"
        }),
    )
    .await;
    assert_eq!(status, 200, "body: {body}");
    let source_id = body["result"]["sourceId"]
        .as_str()
        .expect("source id")
        .to_string();
    assert_eq!(body["result"]["accepted"], true);

    // Repeated registration of the same source coalesces to one identity.
    let (status, repeat) = call(
        &daemon.socket,
        "/v2/sources/register",
        json!({
            "idempotencyKey": "register-2",
            "client": "pi",
            "rootId": "pi-root",
            "path": session.to_str().expect("utf8"),
            "nativeSessionId": "pi-flow-1"
        }),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(repeat["result"]["sourceId"], source_id);

    let body = wait_for_capture(&daemon.socket).await;
    let source = body["result"]["sources"]
        .as_array()
        .expect("sources")
        .iter()
        .find(|source| source["sourceId"] == source_id)
        .expect("registered source");
    assert_eq!(source["client"], "pi");
    assert_eq!(source["repository"], "owner/name");
    assert_eq!(
        source["repositoryVerified"], false,
        "a hint is not verified identity"
    );
    assert_eq!(
        source["path"],
        Value::Null,
        "paths are absent from normal status"
    );
    assert!(source["offset"].as_i64().unwrap_or(0) > 0);
    assert_eq!(source["skippedRecords"], 0);
    assert!(body["result"]["counts"]["caughtUp"].as_i64().unwrap_or(0) >= 1);
    assert!(body["result"]["observedAt"].as_i64().unwrap_or(0) > 0);

    // The explicit local diagnostic reveals the path only when requested.
    let detailed = source_status(&daemon.socket, true).await;
    let detailed_source = detailed["result"]["sources"]
        .as_array()
        .expect("sources")
        .iter()
        .find(|source| source["sourceId"] == source_id)
        .expect("registered source");
    assert_eq!(
        detailed_source["path"].as_str().expect("path"),
        std::fs::canonicalize(&session)
            .expect("canonical")
            .to_str()
            .expect("utf8")
    );
}

#[tokio::test]
async fn hints_coalesce_and_unknown_roots_or_identities_are_rejected() {
    let daemon = start();
    let session = daemon.sources_dir().join("session.jsonl");
    let (_, body) = call(
        &daemon.socket,
        "/v2/sources/register",
        json!({
            "idempotencyKey": "register-1",
            "client": "pi",
            "rootId": "pi-root",
            "path": session.to_str().expect("utf8"),
            "nativeSessionId": "pi-flow-1"
        }),
    )
    .await;
    let source_id = body["result"]["sourceId"]
        .as_str()
        .expect("source")
        .to_string();

    let (status, first) = call(
        &daemon.socket,
        "/v2/sources/hint",
        json!({
            "idempotencyKey": "hint-1",
            "sourceId": source_id,
            "eventId": "event-1",
            "event": "append"
        }),
    )
    .await;
    assert_eq!(status, 200, "body: {first}");
    assert_eq!(first["result"]["accepted"], true);
    assert_eq!(first["result"]["coalesced"], false);

    let (_, repeat) = call(
        &daemon.socket,
        "/v2/sources/hint",
        json!({
            "idempotencyKey": "hint-2",
            "sourceId": source_id,
            "eventId": "event-1",
            "event": "append"
        }),
    )
    .await;
    assert_eq!(
        repeat["result"]["coalesced"], true,
        "repeated event IDs coalesce"
    );

    let (status, unknown) = call(
        &daemon.socket,
        "/v2/sources/hint",
        json!({
            "idempotencyKey": "hint-3",
            "sourceId": "src_missing",
            "eventId": "event-2",
            "event": "append"
        }),
    )
    .await;
    assert_eq!(status, 412);
    assert_eq!(unknown["error"]["reason"], "SOURCE_UNKNOWN");

    let (status, unapproved) = call(
        &daemon.socket,
        "/v2/sources/register",
        json!({
            "idempotencyKey": "register-x",
            "client": "pi",
            "rootId": "not-approved",
            "path": session.to_str().expect("utf8")
        }),
    )
    .await;
    assert_eq!(status, 412);
    assert_eq!(unapproved["error"]["reason"], "SOURCE_ROOT_NOT_APPROVED");

    let (status, mismatch) = call(
        &daemon.socket,
        "/v2/sources/register",
        json!({
            "idempotencyKey": "register-y",
            "client": "pi",
            "rootId": "pi-root",
            "path": session.to_str().expect("utf8"),
            "nativeSessionId": "not-the-header"
        }),
    )
    .await;
    assert_eq!(status, 412);
    assert_eq!(mismatch["error"]["reason"], "SOURCE_IDENTITY_MISMATCH");
}

#[tokio::test]
async fn discovery_finds_approved_files_without_registration() {
    let daemon = start();
    // The scheduler wakes at startup and discovers the fixture without an
    // adapter registration; polling supplies the missed-notification path.
    let body = wait_for_capture(&daemon.socket).await;
    let source = body["result"]["sources"]
        .as_array()
        .expect("sources")
        .iter()
        .find(|source| source["nativeSessionId"] == "pi-flow-1")
        .expect("discovered source");
    assert_eq!(source["state"], "caught_up");
    assert!(source["generation"].as_str().is_some());
}

#[tokio::test]
async fn a_hint_replays_its_acknowledgement_for_the_same_key() {
    let daemon = start();
    let session = daemon.sources_dir().join("replay.jsonl");
    std::fs::write(
        &session,
        concat!(
            "{\"type\":\"session\",\"id\":\"pi-replay-1\",\"cwd\":\"/work\"}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Replay evidence.\"}}\n"
        ),
    )
    .expect("fixture");
    let (status, body) = call(
        &daemon.socket,
        "/v2/sources/register",
        json!({
            "idempotencyKey": "register-replay",
            "client": "pi",
            "rootId": "pi-root",
            "path": session.to_str().expect("utf8"),
            "nativeSessionId": "pi-replay-1"
        }),
    )
    .await;
    assert_eq!(status, 200, "body: {body}");
    let source_id = body["result"]["sourceId"]
        .as_str()
        .expect("source")
        .to_string();

    let hint = |event: &str| {
        json!({
            "idempotencyKey": "hint-replay",
            "sourceId": source_id,
            "eventId": event,
            "event": "append"
        })
    };
    let (status, first) = call(&daemon.socket, "/v2/sources/hint", hint("event-1")).await;
    assert_eq!(status, 200, "body: {first}");
    assert_eq!(first["result"]["coalesced"], false);

    // The retry is the stored acknowledgement, not a fresh (coalesced) delivery.
    let (status, repeat) = call(&daemon.socket, "/v2/sources/hint", hint("event-1")).await;
    assert_eq!(status, 200, "body: {repeat}");
    assert_eq!(repeat["result"], first["result"], "{repeat}");

    // A reused key with different parameters never performs a second mutation.
    let (status, conflict) = call(&daemon.socket, "/v2/sources/hint", hint("event-2")).await;
    assert_eq!(status, 409, "body: {conflict}");
    assert_eq!(
        conflict["error"]["reason"], "IDEMPOTENCY_CONFLICT",
        "{conflict}"
    );
}
