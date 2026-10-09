//! `lore browser` — a foreground loopback gateway for the dashboard.
//!
//! Serves the checked-in browser assets and translates `/api/<view>` requests
//! into read-only daemon view calls. It has no SQL, never proxies mutations,
//! never binds beyond loopback, and dies with the foreground process.

use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use protocol::{RequestMeta, ViewParams};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const INDEX: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../browser/index.html"
));
const APP_JS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../browser/app.js"
));
const STYLES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../browser/styles.css"
));

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const GATEWAY_BUDGET_MS: u64 = 5_000;

const VIEWS: &[&str] = &[
    "overview",
    "memories",
    "memories/filters",
    "maintenance",
    "episodes",
    "drilldown",
    "health",
];

/// Shared gateway state: the daemon socket and the negotiated store id.
struct GatewayState {
    socket: PathBuf,
    store_id: tokio::sync::Mutex<Option<String>>,
}

/// Serve the dashboard until the process is stopped.
pub async fn run(socket: &Path, port: u16, open: bool) -> Result<(), String> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
        .await
        .map_err(|error| format!("bind 127.0.0.1:{port}: {error}"))?;
    let bound = listener.local_addr().map_err(|error| error.to_string())?;
    let url = format!("http://127.0.0.1:{}/", bound.port());
    println!("{url}");
    if open {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }
    let state: Arc<GatewayState> = Arc::new(GatewayState {
        socket: socket.to_path_buf(),
        store_id: tokio::sync::Mutex::new(None),
    });
    loop {
        let (stream, remote) = match listener.accept().await {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !remote.ip().is_loopback() {
            continue;
        }
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let state = Arc::clone(&state);
                async move { Ok::<_, Infallible>(handle(request, state).await) }
            });
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

fn host_allowed(host: &str) -> bool {
    let without_port = if host.starts_with('[') {
        host.split(']')
            .next()
            .map(|value| format!("{value}]"))
            .unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or("").to_string()
    };
    matches!(without_port.as_str(), "127.0.0.1" | "localhost" | "[::1]")
}

fn secure(builder: hyper::http::response::Builder) -> hyper::http::response::Builder {
    builder
        .header("content-security-policy", CSP)
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("x-frame-options", "DENY")
        .header("cache-control", "no-store")
}

fn body(status: StatusCode, content_type: &str, bytes: Bytes) -> Response<Full<Bytes>> {
    secure(Response::builder().status(status))
        .header("content-type", content_type)
        .body(Full::new(bytes))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

fn message(status: StatusCode, text: &str) -> Response<Full<Bytes>> {
    body(
        status,
        "text/plain; charset=utf-8",
        Bytes::from(text.to_string()),
    )
}

async fn handle(request: Request<Incoming>, state: Arc<GatewayState>) -> Response<Full<Bytes>> {
    let method = request.method().clone();
    if method != Method::GET && method != Method::HEAD {
        return message(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    let host_ok = request
        .headers()
        .get(hyper::header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(host_allowed);
    if !host_ok {
        return message(StatusCode::FORBIDDEN, "host not allowed");
    }
    if request.headers().contains_key(hyper::header::ORIGIN) {
        return message(StatusCode::FORBIDDEN, "cross-origin request rejected");
    }
    let path = request.uri().path().to_string();
    let query = request.uri().query().map(str::to_string);
    let response = match path.as_str() {
        "/" | "/index.html" => body(
            StatusCode::OK,
            "text/html; charset=utf-8",
            Bytes::from_static(INDEX.as_bytes()),
        ),
        "/app.js" => body(
            StatusCode::OK,
            "text/javascript; charset=utf-8",
            Bytes::from_static(APP_JS.as_bytes()),
        ),
        "/styles.css" => body(
            StatusCode::OK,
            "text/css; charset=utf-8",
            Bytes::from_static(STYLES.as_bytes()),
        ),
        _ if path.starts_with("/api/") => {
            api(&path["/api/".len()..], query.as_deref(), &state).await
        }
        _ => message(StatusCode::NOT_FOUND, "not found"),
    };
    if method == Method::HEAD {
        let (parts, _) = response.into_parts();
        return Response::from_parts(parts, Full::new(Bytes::new()));
    }
    response
}

fn params_from_query(query: Option<&str>) -> ViewParams {
    let mut params = ViewParams::default();
    let Some(query) = query else {
        return params;
    };
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "limit" => params.limit = value.parse().ok(),
            "pageSize" => params.page_size = value.parse().ok(),
            "cursor" => params.cursor = Some(value.to_string()),
            "repository" => params.repository = Some(value.to_string()),
            "kind" | "type" => params.kind = Some(value.to_string()),
            "scope" => params.scope = Some(value.to_string()),
            "query" | "q" => params.query = Some(value.to_string()),
            "id" => params.id = Some(value.to_string()),
            "includeForgotten" => params.include_forgotten = value == "true" || value == "1",
            _ => {}
        }
    }
    params
}

async fn api(name: &str, query: Option<&str>, state: &GatewayState) -> Response<Full<Bytes>> {
    if name.contains("..") || !VIEWS.contains(&name) {
        return message(StatusCode::NOT_FOUND, "unknown view");
    }
    let mut params = params_from_query(query);
    adjust_params(name, query, &mut params);
    let route = format!("/v2/views/{name}");
    let params_json = serde_json::to_value(&params).unwrap_or_default();
    let store_id = match gateway_store_id(state).await {
        Ok(store_id) => store_id,
        Err(response) => return response,
    };
    let mut outcome = view_request(state, &route, &params_json, &store_id).await;
    // The daemon may have been replaced by one serving a different store;
    // refresh the identity once and retry rather than serving a mismatch.
    if let Ok((_, body)) = &outcome {
        let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        if parsed["error"]["reason"] == "STORE_ID_MISMATCH" {
            let refreshed = match gateway_store_id_refresh(state).await {
                Ok(store_id) => store_id,
                Err(response) => return response,
            };
            outcome = view_request(state, &route, &params_json, &refreshed).await;
        }
    }
    match outcome {
        Ok((success, raw_body)) => {
            let parsed: Value =
                serde_json::from_str(&raw_body).unwrap_or_else(|_| json!({ "ok": false }));
            if success && parsed["ok"] == true {
                // The gateway serves the v1 dashboard assets, so the read-only
                // view payloads are translated into the field names those
                // assets consume. Unknown shapes pass through unchanged.
                let translated = translate_view(name, query, &parsed["result"]);
                let value = json!({ "data": translated });
                body(
                    StatusCode::OK,
                    "application/json; charset=utf-8",
                    Bytes::from(serde_json::to_vec(&value).unwrap_or_default()),
                )
            } else {
                downstream_error(&parsed)
            }
        }
        Err(_) => daemon_unavailable(),
    }
}

#[allow(clippy::result_large_err)]
async fn gateway_store_id(state: &GatewayState) -> Result<String, Response<Full<Bytes>>> {
    if let Some(store_id) = state.store_id.lock().await.clone() {
        return Ok(store_id);
    }
    gateway_store_id_refresh(state).await
}

#[allow(clippy::result_large_err)]
async fn gateway_store_id_refresh(state: &GatewayState) -> Result<String, Response<Full<Bytes>>> {
    let meta = browser_meta();
    match lore::request(&state.socket, "/v2/status", meta, json!({})).await {
        Ok(outcome) => {
            let parsed: Value =
                serde_json::from_str(&outcome.body).unwrap_or_else(|_| json!({ "ok": false }));
            match (outcome.is_success() && parsed["ok"] == true)
                .then(|| parsed["storeId"].as_str().map(str::to_string))
                .flatten()
            {
                Some(store_id) => {
                    *state.store_id.lock().await = Some(store_id.clone());
                    Ok(store_id)
                }
                None => Err(downstream_error(&parsed)),
            }
        }
        Err(_) => Err(daemon_unavailable()),
    }
}

async fn view_request(
    state: &GatewayState,
    route: &str,
    params: &Value,
    store_id: &str,
) -> Result<(bool, String), ()> {
    let mut meta = browser_meta();
    meta.expected_store_id = Some(store_id.to_string());
    match lore::request(&state.socket, route, meta, params.clone()).await {
        Ok(outcome) => Ok((outcome.is_success(), outcome.body)),
        Err(_) => Err(()),
    }
}

fn browser_meta() -> RequestMeta {
    RequestMeta {
        client_id: "browser".to_string(),
        request_id: format!("browser-{}-{}", std::process::id(), nanos()),
        session_id: None,
        expected_store_id: None,
        timeout_ms: Some(GATEWAY_BUDGET_MS),
        required_capabilities: Vec::new(),
    }
}

fn downstream_error(parsed: &Value) -> Response<Full<Bytes>> {
    let error = parsed
        .get("error")
        .cloned()
        .unwrap_or_else(|| json!({ "reason": "GATEWAY_ERROR" }));
    body(
        StatusCode::BAD_GATEWAY,
        "application/json; charset=utf-8",
        Bytes::from(serde_json::to_vec(&json!({ "error": error })).unwrap_or_default()),
    )
}

fn daemon_unavailable() -> Response<Full<Bytes>> {
    body(
        StatusCode::BAD_GATEWAY,
        "application/json; charset=utf-8",
        Bytes::from(
            serde_json::to_vec(&json!({ "error": { "reason": "DAEMON_UNAVAILABLE" } }))
                .unwrap_or_default(),
        ),
    )
}

fn query_pairs(query: Option<&str>) -> Vec<(String, String)> {
    query
        .map(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn query_value(pairs: &[(String, String)], key: &str) -> Option<String> {
    pairs
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.clone())
}

/// The v1 dashboard pages by offset; the v2 view pages by keyset. Translate
/// the offset request into a bounded fetch and mark how many were skipped.
fn adjust_params(name: &str, query: Option<&str>, params: &mut ViewParams) {
    let pairs = query_pairs(query);
    if name == "memories" {
        let page = query_value(&pairs, "page")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(1)
            .clamp(1, 40);
        let page_size = query_value(&pairs, "pageSize")
            .or_else(|| query_value(&pairs, "limit"))
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(25)
            .clamp(1, 200);
        params.page_size = Some(page.saturating_mul(page_size).min(200));
        if page > 1 {
            params.limit = Some((page - 1).saturating_mul(page_size));
        }
        let state = query_value(&pairs, "state").unwrap_or_else(|| "active".to_string());
        params.include_forgotten = state != "active";
        params.cursor = None;
    }
}

fn translate_memories(query: Option<&str>, result: &Value) -> Value {
    let pairs = query_pairs(query);
    let page = query_value(&pairs, "page")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1)
        .max(1);
    let page_size = query_value(&pairs, "pageSize")
        .or_else(|| query_value(&pairs, "limit"))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(25)
        .clamp(1, 200);
    let items: Vec<Value> = result["items"].as_array().cloned().unwrap_or_default();
    let skip = ((page - 1).saturating_mul(page_size)) as usize;
    let rows: Vec<Value> = items
        .iter()
        .skip(skip)
        .take(page_size as usize)
        .map(|item| {
            json!({
                "id": item["id"],
                "type": item["kind"],
                "content": item["content"],
                "confidence": item["confidence"],
                "sourceSessionId": item["sourceSessionId"],
                "sourceTurnIndex": null,
                "scope": item["scope"],
                "scopeSource": item["authority"],
                "repository": item["repository"],
                "tags": item["tags"],
                "createdAt": item["createdMs"],
                "updatedAt": item["updatedMs"],
                "supersededBy": null,
                "canonicalKey": null,
                "reinforcementCount": null,
                "lastSeenAt": null,
                "expiresAt": item["expiresAtMs"],
                "metadata": {},
            })
        })
        .collect();
    let more = items.len() as u64 > skip as u64 + rows.len() as u64;
    let total = if more {
        (page * page_size + 1) as i64
    } else {
        (skip as u64 + rows.len() as u64) as i64
    };
    json!({
        "page": page,
        "pageSize": page_size,
        "total": total,
        "rows": rows,
    })
}

fn translate_filters(result: &Value) -> Value {
    let kinds: Vec<Value> = result["kinds"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|row| json!({ "type": row["kind"], "count": row["count"] }))
        .collect();
    let scopes: Vec<Value> = result["scopes"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|row| json!({ "scope": row["scope"], "count": row["count"] }))
        .collect();
    let repositories: Vec<Value> = result["repositories"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|row| json!({ "repository": row["repository"], "count": row["count"] }))
        .collect();
    json!({
        "types": kinds,
        "scopes": scopes,
        "repositories": repositories,
        "canonicalKeys": [],
    })
}

fn translate_maintenance(result: &Value) -> Value {
    // Real persisted task state wins; the count-derived rows remain for
    // older payload shapes.
    if let Some(states) = result["taskStates"].as_array()
        && !states.is_empty()
    {
        let task_states: Vec<Value> = states
            .iter()
            .map(|row| {
                json!({
                    "task_name": row["task"],
                    "last_status": row["lastState"],
                    "total_runs": row["runs"],
                    "total_failures": row["failures"],
                    "total_needs_attention": row["needsAttention"],
                    "last_completed_at": row["lastRunMs"],
                })
            })
            .collect();
        return json!({
            "runs": result["runs"],
            "taskStates": task_states,
            "deferred": [],
            "doctorReports": [],
            "trajectory": [],
            "maintenancePlan": {
                "dueTasks": result["dueTasks"],
                "selectedTasks": [],
                "skippedDueToCap": [],
            },
            "recentTraceSamples": [],
            "embeddingJobs": result["embeddingJobs"],
            "extraction": result["extraction"],
            "sources": result["sources"],
        });
    }
    let mut task_states: Vec<Value> = Vec::new();
    for (key, name) in [
        ("embeddingJobs", "embedding_jobs"),
        ("extraction", "extraction"),
        ("sources", "sources"),
    ] {
        for row in result[key].as_array().cloned().unwrap_or_default() {
            task_states.push(json!({
                "task_name": format!("{name}:{}", row["state"].as_str().unwrap_or("unknown")),
                "last_status": row["state"],
                "total_runs": row["count"],
                "total_failures": 0,
                "total_needs_attention": 0,
                "last_completed_at": null,
            }));
        }
    }
    json!({
        "runs": [],
        "taskStates": task_states,
        "deferred": [],
        "doctorReports": [],
        "trajectory": [],
        "maintenancePlan": {
            "dueTasks": [],
            "selectedTasks": [],
            "skippedDueToCap": [],
        },
        "recentTraceSamples": [],
        "embeddingJobs": result["embeddingJobs"],
        "extraction": result["extraction"],
        "sources": result["sources"],
    })
}

fn translate_overview(result: &Value) -> Value {
    let kind_count = |kind: &str| -> i64 {
        result["kinds"]
            .as_array()
            .and_then(|rows| {
                rows.iter()
                    .find(|row| row["kind"] == kind)
                    .and_then(|row| row["count"].as_i64())
            })
            .unwrap_or(0)
    };
    json!({
        "stats": {
            "semanticCount": result["activeMemories"],
            "episodeCount": kind_count("episode_digest"),
            "daySummaryCount": kind_count("day_summary"),
            "retrievalTraceSampleCount": 0,
            "forgottenCount": result["forgottenMemories"],
        },
        "latencyTrend": { "recentAverageMs": null, "trend": "no_samples" },
        "activity": [],
        "activeWorkstreams": [],
        "maintenance": {
            "dueTasks": [],
            "selectedTasks": [],
            "recentRuns": [],
            "skippedDueToCap": [],
        },
        "captureHealth": translate_capture_health(result),
        "indexing": {
            "enabled": true,
            "coveragePercent": null,
            "totalActive": result["activeMemories"],
            "fallbackDiagnostics": [],
        },
        "storeId": result["storeId"],
        "repositories": result["repositories"],
        "kinds": result["kinds"],
        "sources": result["sources"],
        "pendingExtraction": result["pendingExtraction"],
    })
}

fn translate_capture_health(result: &Value) -> Value {
    let rows: Vec<Value> = result["captureHealth"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|row| {
            let state = row["state"].as_str().unwrap_or("unknown");
            let pending_bytes = row["pendingBytes"].as_i64().unwrap_or(0);
            let status = match state {
                "caught_up" => "healthy",
                "growing" => "pending",
                "unavailable" => "unavailable",
                "failed" => "failed",
                _ => "pending",
            };
            json!({
                "client": row["client"],
                "sessionId": row["sessionId"],
                "repository": row["repository"],
                "originLabel": row["repository"],
                "lastSuccessAt": row["lastProgressMs"],
                "pendingBytes": pending_bytes,
                "status": status,
                "failureCode": row["lastError"],
                "offset": row["offset"],
                "pendingWork": null,
            })
        })
        .collect();
    json!(rows)
}

fn translate_drilldown(result: &Value) -> Value {
    if result["found"] != true {
        return json!({ "found": false, "entityType": "memory" });
    }
    let memory = &result["memory"];
    let provenance: Vec<Value> = result["evidence"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|row| {
            json!({
                "sourceId": row["sourceId"],
                "evidenceKey": row["evidenceKey"],
                "role": row["role"],
                "createdAt": row["createdMs"],
                "retiredAt": row["retiredMs"],
            })
        })
        .collect();
    json!({
        "found": true,
        "entityType": "memory",
        "memory": memory,
        "evidence": result["evidence"],
        "suppressed": result["suppressed"],
        "focus": {
            "entityType": "memory",
            "id": memory["id"],
            "type": memory["kind"],
            "content": memory["content"],
            "scope": memory["scope"],
            "repository": memory["repository"],
            "canonicalKey": null,
            "updatedAt": memory["updatedMs"],
        },
        "provenance": provenance,
        "lineage": { "supersededBy": memory["supersededBy"] },
        "canonicalCluster": null,
        "linkedImprovements": [],
        "lifecycle": {
            "forgotten": memory["forgotten"],
            "suppressed": result["suppressed"],
        },
        "graph": { "nodes": [], "edges": [] },
    })
}

fn translate_view(name: &str, query: Option<&str>, result: &Value) -> Value {
    match name {
        "overview" => translate_overview(result),
        "memories" => translate_memories(query, result),
        "memories/filters" => translate_filters(result),
        "maintenance" => translate_maintenance(result),
        "drilldown" => translate_drilldown(result),
        "health" => json!({
            "ok": true,
            "loreCliPath": null,
            "schemaVersion": result["schemaVersion"],
            "ftsHealthy": result["ftsHealthy"],
            "ftsRows": result["ftsRows"],
            "migrationState": result["migrationState"],
            "ready": result["ready"],
        }),
        _ => result.clone(),
    }
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn memory(id: &str) -> Value {
        json!({
            "id": id,
            "kind": "note",
            "content": format!("content {id}"),
            "scope": "global",
            "repository": null,
            "authority": "manual",
            "confidence": 1.0,
            "createdMs": 1,
            "updatedMs": 2,
            "expiresAtMs": null,
            "sourceSessionId": null,
            "tags": [],
        })
    }

    #[test]
    fn memories_translation_pages_by_offset_in_v1_field_names() {
        let result = json!({
            "items": [memory("a"), memory("b"), memory("c")],
            "nextCursor": null,
            "pageSize": 3,
        });
        let page_one = translate_memories(Some("page=1&pageSize=2"), &result);
        assert_eq!(page_one["page"], 1);
        assert_eq!(page_one["pageSize"], 2);
        assert_eq!(page_one["rows"].as_array().expect("rows").len(), 2);
        assert_eq!(page_one["rows"][0]["type"], "note");
        assert_eq!(page_one["rows"][0]["updatedAt"], 2);
        assert_eq!(page_one["rows"][0]["canonicalKey"], Value::Null);
        assert_eq!(page_one["total"], 3, "more rows remain");

        let page_two = translate_memories(Some("page=2&pageSize=2"), &result);
        assert_eq!(page_two["rows"].as_array().expect("rows").len(), 1);
        assert_eq!(page_two["total"], 3);

        let page_three = translate_memories(Some("page=3&pageSize=2"), &result);
        assert_eq!(page_three["rows"].as_array().expect("rows").len(), 0);
        assert_eq!(page_three["total"], 4);
    }

    #[test]
    fn offset_request_is_bounded_before_dispatch() {
        let mut params = ViewParams::default();
        adjust_params(
            "memories",
            Some("page=3&pageSize=10&state=all"),
            &mut params,
        );
        assert_eq!(params.page_size, Some(30));
        assert_eq!(params.limit, Some(20));
        assert!(params.include_forgotten);

        let mut params = ViewParams::default();
        adjust_params("memories", Some("state=active"), &mut params);
        assert_eq!(params.page_size, Some(25));
        assert_eq!(params.limit, None);
        assert!(!params.include_forgotten);
    }

    #[test]
    fn overview_stats_use_dashboard_names_without_inventing_history() {
        let overview = translate_overview(&json!({
            "storeId": "s",
            "activeMemories": 4,
            "forgottenMemories": 1,
            "repositories": [],
            "kinds": [
                { "kind": "episode_digest", "count": 2 },
                { "kind": "day_summary", "count": 1 },
            ],
            "sources": { "total": 0, "caughtUp": 0 },
            "captureHealth": [
                {
                    "client": "pi",
                    "sessionId": "s-1",
                    "repository": "acme/app",
                    "state": "growing",
                    "offset": 10,
                    "observedSize": 52,
                    "pendingBytes": 42,
                    "lastProgressMs": 5,
                    "lastError": null,
                },
                {
                    "client": "codex",
                    "sessionId": "s-2",
                    "repository": null,
                    "state": "failed",
                    "offset": 0,
                    "observedSize": 0,
                    "pendingBytes": 0,
                    "lastProgressMs": null,
                    "lastError": "PARSER_STATE_INVALID",
                }
            ],
            "pendingExtraction": 0,
        }));
        assert_eq!(overview["stats"]["semanticCount"], 4);
        assert_eq!(overview["stats"]["episodeCount"], 2);
        assert_eq!(overview["stats"]["daySummaryCount"], 1);
        assert_eq!(overview["indexing"]["totalActive"], 4);
        assert_eq!(overview["latencyTrend"]["trend"], "no_samples");
        let health = overview["captureHealth"].as_array().expect("health");
        assert_eq!(health.len(), 2);
        assert_eq!(health[0]["status"], "pending");
        assert_eq!(health[0]["pendingBytes"], 42);
        assert_eq!(health[0]["lastSuccessAt"], 5);
        assert_eq!(health[1]["status"], "failed");
        assert_eq!(health[1]["failureCode"], "PARSER_STATE_INVALID");
    }

    #[test]
    fn filters_and_maintenance_keep_v1_keys() {
        let filters = translate_filters(&json!({
            "kinds": [{"kind": "note", "count": 2}],
            "scopes": [{"scope": "global", "count": 2}],
            "repositories": [{"repository": "acme/app", "count": 1}],
        }));
        assert_eq!(filters["types"][0]["type"], "note");
        assert_eq!(filters["types"][0]["count"], 2);
        assert_eq!(filters["scopes"][0]["scope"], "global");
        assert_eq!(filters["repositories"][0]["repository"], "acme/app");
        assert!(
            filters["canonicalKeys"]
                .as_array()
                .expect("keys")
                .is_empty()
        );

        let maintenance = translate_maintenance(&json!({
            "embeddingJobs": [{"state": "queued", "count": 3}],
            "extraction": [],
            "sources": [{"state": "caught_up", "count": 1}],
        }));
        assert_eq!(
            maintenance["taskStates"][0]["task_name"],
            "embedding_jobs:queued"
        );
        assert_eq!(maintenance["taskStates"][0]["total_runs"], 3);
        assert!(maintenance["runs"].as_array().expect("runs").is_empty());
        assert!(
            maintenance["maintenancePlan"]["dueTasks"]
                .as_array()
                .expect("due")
                .is_empty()
        );
    }

    #[test]
    fn drilldown_translation_shapes_focus_and_graph() {
        let translated = translate_drilldown(&json!({
            "found": true,
            "memory": {
                "id": "mem-1",
                "kind": "note",
                "content": "Parity row.",
                "scope": "global",
                "repository": null,
                "authority": "manual",
                "confidence": 1.0,
                "createdMs": 1,
                "updatedMs": 2,
                "forgotten": false,
                "supersededBy": null,
            },
            "evidence": [{
                "sourceId": "src-1",
                "generation": "g1",
                "evidenceKey": "e1",
                "role": "user",
                "createdMs": 3,
                "retiredMs": null,
            }],
            "suppressed": false,
        }));
        assert_eq!(translated["entityType"], "memory");
        assert_eq!(translated["focus"]["id"], "mem-1");
        assert_eq!(translated["provenance"][0]["sourceId"], "src-1");
        assert_eq!(
            translated["graph"]["nodes"]
                .as_array()
                .expect("nodes")
                .len(),
            0
        );
        assert_eq!(translated["lifecycle"]["suppressed"], false);

        let missing = translate_drilldown(&json!({ "found": false }));
        assert_eq!(missing["found"], false);
        assert_eq!(missing["entityType"], "memory");
    }
}
