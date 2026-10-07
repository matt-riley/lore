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
    let socket: Arc<PathBuf> = Arc::new(socket.to_path_buf());
    loop {
        let (stream, remote) = match listener.accept().await {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !remote.ip().is_loopback() {
            continue;
        }
        let socket = Arc::clone(&socket);
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let socket = Arc::clone(&socket);
                async move { Ok::<_, Infallible>(handle(request, socket).await) }
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

async fn handle(request: Request<Incoming>, socket: Arc<PathBuf>) -> Response<Full<Bytes>> {
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
            api(&path["/api/".len()..], query.as_deref(), &socket).await
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

async fn api(name: &str, query: Option<&str>, socket: &Path) -> Response<Full<Bytes>> {
    if name.contains("..") || !VIEWS.contains(&name) {
        return message(StatusCode::NOT_FOUND, "unknown view");
    }
    let params = params_from_query(query);
    let meta = RequestMeta {
        client_id: "browser".to_string(),
        request_id: format!("browser-{}-{}", std::process::id(), nanos()),
        session_id: None,
        expected_store_id: None,
        timeout_ms: Some(GATEWAY_BUDGET_MS),
        required_capabilities: Vec::new(),
    };
    let route = format!("/v2/views/{name}");
    match lore::request(
        socket,
        &route,
        meta,
        serde_json::to_value(params).unwrap_or_default(),
    )
    .await
    {
        Ok(outcome) => {
            let parsed: Value =
                serde_json::from_str(&outcome.body).unwrap_or_else(|_| json!({ "ok": false }));
            if outcome.is_success() && parsed["ok"] == true {
                let value = json!({ "data": parsed["result"].clone() });
                body(
                    StatusCode::OK,
                    "application/json; charset=utf-8",
                    Bytes::from(serde_json::to_vec(&value).unwrap_or_default()),
                )
            } else {
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
        }
        Err(_) => body(
            StatusCode::BAD_GATEWAY,
            "application/json; charset=utf-8",
            Bytes::from(
                serde_json::to_vec(&json!({ "error": { "reason": "DAEMON_UNAVAILABLE" } }))
                    .unwrap_or_default(),
            ),
        ),
    }
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}
