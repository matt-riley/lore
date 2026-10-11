//! Governance routes: backlog, ledger, journal, review gate, repair, replay.

use std::path::Path;
use std::time::Duration;

use protocol::RequestMeta;
use serde_json::{Value, json};

mod support;
use support::Daemon;

fn meta(store_id: Option<&str>) -> RequestMeta {
    RequestMeta {
        client_id: "test.rust.governance".to_string(),
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
    panic!(
        "daemon never accepted requests; stderr:\n{}",
        support::stderr_for(socket)
    );
}

async fn store_id(daemon: &Daemon) -> String {
    let (_, status) = call(&daemon.socket, "/v2/status", json!({}), None).await;
    status["storeId"].as_str().expect("store").to_string()
}

#[tokio::test]
async fn backlog_journal_and_review_gate_round_trip() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon).await;

    let (code, added) = call(
        &daemon.socket,
        "/v2/admin/backlog",
        json!({ "action": "add", "idempotencyKey": "gov-backlog-add-1", "title": "Port the exporter", "kind": "improvement" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{added}");
    let item = added["result"]["id"].as_str().expect("item id").to_string();

    let (code, gate) = call(
        &daemon.socket,
        "/v2/admin/review-gate",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{gate}");
    assert_eq!(gate["result"]["gate"], "open");
    assert_eq!(gate["result"]["counts"]["proposed"], 1);

    let (code, decided) = call(
        &daemon.socket,
        "/v2/admin/review-gate",
        json!({ "action": "decide", "idempotencyKey": "gov-review-decide-1", "id": item, "state": "accepted" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{decided}");
    let (_, gate) = call(
        &daemon.socket,
        "/v2/admin/review-gate",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(gate["result"]["gate"], "clear");

    let (code, journaled) = call(
        &daemon.socket,
        "/v2/admin/journal",
        json!({ "action": "add", "idempotencyKey": "gov-journal-add-1", "intent": "Ship adapters next", "note": "after governance" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{journaled}");
    let entry = journaled["result"]["id"]
        .as_str()
        .expect("journal id")
        .to_string();
    let (code, listed) = call(
        &daemon.socket,
        "/v2/admin/journal",
        json!({ "state": "open" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{listed}");
    assert_eq!(listed["result"]["items"][0]["intent"], "Ship adapters next");
    let (code, moved) = call(
        &daemon.socket,
        "/v2/admin/journal",
        json!({ "action": "update", "idempotencyKey": "gov-journal-update-1", "id": entry, "state": "doing" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{moved}");

    let (code, ledger) = call(
        &daemon.socket,
        "/v2/admin/ledger",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{ledger}");
    assert!(
        ledger["result"]["entries"]
            .as_array()
            .expect("entries")
            .len()
            >= 2
    );
    let (code, appended) = call(
        &daemon.socket,
        "/v2/admin/ledger",
        json!({ "action": "append", "idempotencyKey": "gov-ledger-append-1", "entryType": "note", "detail": "manual checkpoint" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{appended}");

    let (_, unknown) = call(
        &daemon.socket,
        "/v2/admin/ledger",
        json!({ "entryType": "not-a-type" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(unknown["error"]["reason"], "ADMIN_ARGUMENT_INVALID");
}

#[tokio::test]
async fn repair_preview_applies_and_refuses_stale_plans() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon).await;
    let memory = {
        let (code, body) = call(
            &daemon.socket,
            "/v2/retain",
            json!({
                "idempotencyKey": "gov-repair-1",
                "type": "note",
                "content": "Repair target content.",
                "scope": "global"
            }),
            Some(&store_id),
        )
        .await;
        assert_eq!(code, 200, "{body}");
        body["result"]["memoryId"].as_str().expect("id").to_string()
    };

    // Remove the FTS row behind the store's back to create a repairable gap.
    {
        let db = daemon.dir.path().join("lore-v2.db");
        let connection = rusqlite::Connection::open(&db).expect("open db");
        connection
            .execute(
                "DELETE FROM memory_fts WHERE memory_id = ?1",
                rusqlite::params![memory],
            )
            .expect("delete fts row");
    }

    let (code, preview) = call(
        &daemon.socket,
        "/v2/admin/repair",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{preview}");
    assert_eq!(preview["result"]["counts"]["fts_missing"], 1);
    let fingerprint = preview["result"]["fingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();

    let (code, stale) = call(
        &daemon.socket,
        "/v2/admin/repair",
        json!({ "action": "apply", "idempotencyKey": "gov-repair-stale-1", "planFingerprint": "wrong" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 412, "{stale}");

    let (code, applied) = call(
        &daemon.socket,
        "/v2/admin/repair",
        json!({ "action": "apply", "idempotencyKey": "gov-repair-apply-1", "planFingerprint": fingerprint, "actor": "tester" }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{applied}");
    assert_eq!(applied["result"]["counts"]["ftsRebuilt"], 1);
    assert!(applied["result"]["runId"].as_str().is_some());

    let (code, after) = call(
        &daemon.socket,
        "/v2/admin/repair",
        json!({}),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{after}");
    assert_eq!(after["result"]["counts"]["fts_missing"], 0);

    let (_, search) = call(
        &daemon.socket,
        "/v2/recall",
        json!({ "query": "repair target", "limit": 5 }),
        Some(&store_id),
    )
    .await;
    assert!(
        search["result"]["context"]
            .as_str()
            .unwrap_or("")
            .contains("Repair target"),
        "{search}"
    );
}

#[tokio::test]
async fn replay_runs_the_frozen_corpus() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon).await;
    let (code, replay) = call(
        &daemon.socket,
        "/v2/admin/replay",
        json!({ "limit": 160 }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{replay}");
    assert_eq!(replay["result"]["failed"], 0, "{replay}");
    assert_eq!(replay["result"]["passed"], 160);
    assert!(replay["result"]["corpusVersion"].as_u64().unwrap_or(0) >= 1);
}

#[tokio::test]
async fn skill_validate_reads_roots_without_executing() {
    let daemon = Daemon::start();
    let store_id = store_id(&daemon).await;
    let skills_root = daemon.dir.path().join("skills");
    let good = skills_root.join("good-skill");
    std::fs::create_dir_all(&good).expect("mkdir");
    std::fs::write(
        good.join("SKILL.md"),
        "---\nname: good-skill\ndescription: A skill used in a test.\n---\n\nDo the thing.\n",
    )
    .expect("write skill");
    let bad = skills_root.join("bad-skill");
    std::fs::create_dir_all(&bad).expect("mkdir");
    std::fs::write(bad.join("SKILL.md"), "# No front matter\n").expect("write bad skill");

    let (code, report) = call(
        &daemon.socket,
        "/v2/admin/skill-validate",
        json!({ "paths": [skills_root.to_str().expect("utf8")] }),
        Some(&store_id),
    )
    .await;
    assert_eq!(code, 200, "{report}");
    assert_eq!(report["result"]["ok"], false);
    let skills = report["result"]["skills"].as_array().expect("skills");
    assert_eq!(skills.len(), 2);
    let good_report = skills
        .iter()
        .find(|skill| skill["name"] == "good-skill")
        .expect("good skill");
    assert_eq!(good_report["ok"], true);
    let bad_report = skills
        .iter()
        .find(|skill| skill["path"].as_str().unwrap_or("").contains("bad-skill"))
        .expect("bad skill");
    assert_eq!(bad_report["ok"], false);
}
