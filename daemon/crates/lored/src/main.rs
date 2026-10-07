//! `lored` — the Lore v2 daemon. G1 proof: `POST /v2/status` over a Unix
//! socket with the contract envelope, Host, size, number-safety, deadline and
//! bounded-overload validation.
//!
//! Deliberately absent from this scaffold: storage, identity locks, other
//! routes, cancellation and the full Status surface. See `daemon/README.md`.

use std::convert::Infallible;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use clap::Parser;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;

use protocol::{
    API_MAJOR, API_MINOR, BODY_DEADLINE_MS, Envelope, ErrorDetail, ErrorEnvelope, HOST,
    MAX_BODY_BYTES, MAX_INFLIGHT_DEFAULT, MAX_TIMEOUT_MS, OkEnvelope, Readiness, StatusParams,
    StatusResult, code, has_unsafe_integer, reason,
};

type Resp = Response<Full<Bytes>>;

#[derive(Debug, Parser)]
#[command(name = "lored", version, about = "Lore v2 daemon (G1 status proof)")]
struct Args {
    /// Unix socket path. Refuses to replace an existing path.
    #[arg(long, env = "LORE_V2_SOCKET")]
    socket: PathBuf,
    /// Immutable store identity reported by Status.
    #[arg(long, env = "LORE_V2_STORE_ID", default_value = "store-g1-proof")]
    store_id: String,
    /// Maximum concurrent in-flight requests before overload rejection.
    #[arg(long, env = "LORE_V2_MAX_INFLIGHT", default_value_t = MAX_INFLIGHT_DEFAULT)]
    max_inflight: usize,
}

struct State {
    store_id: String,
    process_instance_id: String,
    started: Instant,
    inflight: Arc<Semaphore>,
}

/// Marker for an exceeded operation deadline.
struct DeadlineExceeded;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let args = Args::parse();
    if args.socket.exists() {
        bail!(
            "refusing to replace existing socket path {}",
            args.socket.display()
        );
    }
    if let Some(parent) = args.socket.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let listener = UnixListener::bind(&args.socket)
        .with_context(|| format!("bind {}", args.socket.display()))?;
    std::fs::set_permissions(&args.socket, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod {}", args.socket.display()))?;

    let state = Arc::new(State {
        store_id: args.store_id,
        process_instance_id: format!(
            "{}-{:x}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ),
        started: Instant::now(),
        inflight: Arc::new(Semaphore::new(args.max_inflight.max(1))),
    });
    eprintln!("[lored] listening on {}", args.socket.display());

    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.context("accept")?;
                let state = Arc::clone(&state);
                tokio::spawn(async move { serve(stream, state).await });
            }
            _ = tokio::signal::ctrl_c() => break,
            _ = terminate.recv() => break,
        }
    }
    eprintln!("[lored] shutting down");
    drop(listener);
    let _ = std::fs::remove_file(&args.socket);
    Ok(())
}

async fn serve(stream: UnixStream, state: Arc<State>) {
    let service = service_fn(move |request| {
        let state = Arc::clone(&state);
        async move { Ok::<Resp, Infallible>(handle(request, state).await) }
    });
    if let Err(error) = http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .await
    {
        eprintln!("[lored] connection error: {error}");
    }
}

async fn handle(request: Request<Incoming>, state: Arc<State>) -> Resp {
    if request.method() != Method::POST {
        let mut response = error(
            StatusCode::METHOD_NOT_ALLOWED,
            code::INVALID_ARGUMENT,
            reason::METHOD_NOT_ALLOWED,
            false,
            None,
            None,
        );
        response.headers_mut().insert(
            hyper::header::ALLOW,
            hyper::header::HeaderValue::from_static("POST"),
        );
        return response;
    }
    if request.uri().path() != "/v2/status" {
        return error(
            StatusCode::NOT_IMPLEMENTED,
            code::UNIMPLEMENTED,
            reason::ROUTE_UNIMPLEMENTED,
            false,
            None,
            None,
        );
    }
    if request
        .headers()
        .get(hyper::header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(HOST)
    {
        return error(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_HOST,
            false,
            None,
            None,
        );
    }
    if request.headers().contains_key(hyper::header::ORIGIN) {
        return error(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_HOST,
            false,
            None,
            None,
        );
    }
    let content_type = request
        .headers()
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type.starts_with("application/json") {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            code::INVALID_ARGUMENT,
            reason::UNSUPPORTED_MEDIA_TYPE,
            false,
            None,
            None,
        );
    }

    // Hold a permit for the whole request, including the body read, so a slow
    // or stalled peer cannot consume unbounded work.
    let Ok(_permit) = Arc::clone(&state.inflight).try_acquire_owned() else {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            code::RESOURCE_EXHAUSTED,
            reason::REQUEST_CAPACITY,
            true,
            None,
            None,
        );
    };

    // Header/body receive deadline is independent of the operation deadline.
    let collected = match tokio::time::timeout(
        Duration::from_millis(BODY_DEADLINE_MS),
        Limited::new(request.into_body(), MAX_BODY_BYTES).collect(),
    )
    .await
    {
        Err(_) => {
            return error(
                StatusCode::REQUEST_TIMEOUT,
                code::DEADLINE_EXCEEDED,
                reason::REQUEST_TIMEOUT,
                true,
                None,
                None,
            );
        }
        Ok(Err(_)) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                code::RESOURCE_EXHAUSTED,
                reason::REQUEST_BYTES,
                false,
                None,
                None,
            );
        }
        Ok(Ok(collected)) => collected,
    };
    let raw = collected.to_bytes();

    let Ok(envelope) = serde_json::from_slice::<Envelope<StatusParams>>(&raw) else {
        return error(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_JSON,
            false,
            None,
            None,
        );
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return error(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_JSON,
            false,
            None,
            None,
        );
    };
    let request_id = envelope.meta.request_id.clone();
    let store_id = state.store_id.clone();
    if has_unsafe_integer(&value) {
        return error(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::UNSAFE_INTEGER,
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }
    if envelope.meta.timeout_ms == Some(0) {
        return error(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_DEADLINE,
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }
    if let Some(expected) = envelope.meta.expected_store_id.as_deref()
        && expected != state.store_id
    {
        return error(
            StatusCode::PRECONDITION_FAILED,
            code::FAILED_PRECONDITION,
            reason::STORE_MISMATCH,
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }
    if let Some(expected) = envelope.params.expected_api_major
        && expected != API_MAJOR
    {
        return error(
            StatusCode::PRECONDITION_FAILED,
            code::FAILED_PRECONDITION,
            reason::API_MAJOR_MISMATCH,
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }

    let deadline = envelope
        .meta
        .timeout_ms
        .map(|millis| Duration::from_millis(millis.min(MAX_TIMEOUT_MS)));
    let work = StatusResult {
        api_major: API_MAJOR,
        api_minor: API_MINOR,
        daemon_version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: 1,
        store_id: store_id.clone(),
        process_instance_id: state.process_instance_id.clone(),
        uptime_ms: state.started.elapsed().as_millis() as u64,
        readiness: Readiness::Ready,
        capabilities: vec!["status.basic".to_string()],
    };
    match with_deadline(deadline, async { work }).await {
        Err(DeadlineExceeded) => error(
            StatusCode::GATEWAY_TIMEOUT,
            code::DEADLINE_EXCEEDED,
            reason::REQUEST_DEADLINE,
            true,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(result) => json(
            StatusCode::OK,
            &OkEnvelope {
                ok: true,
                request_id,
                store_id,
                result,
            },
        ),
    }
}

/// Run `work` under an optional operation deadline.
async fn with_deadline<F: std::future::Future>(
    deadline: Option<Duration>,
    work: F,
) -> Result<F::Output, DeadlineExceeded> {
    match deadline {
        Some(limit) => tokio::time::timeout(limit, work)
            .await
            .map_err(|_| DeadlineExceeded),
        None => Ok(work.await),
    }
}

fn json<T: Serialize>(status: StatusCode, value: &T) -> Resp {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    if body.len() > MAX_BODY_BYTES {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header(hyper::header::CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::from_static(
                br#"{"ok":false,"error":{"code":"INTERNAL","reason":"INTERNAL_FAILURE","retryable":false,"message":"response exceeded the protocol cap"}}"#,
            )))
            .expect("static response shape is valid");
    }
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)))
        .expect("static response shape is valid")
}

fn error(
    status: StatusCode,
    code: &str,
    reason: &str,
    retryable: bool,
    request_id: Option<&str>,
    store_id: Option<&str>,
) -> Resp {
    json(
        status,
        &ErrorEnvelope {
            ok: false,
            request_id: request_id.map(str::to_string),
            store_id: store_id.map(str::to_string),
            error: ErrorDetail {
                code: code.to_string(),
                reason: reason.to_string(),
                retryable,
                message: "request rejected".to_string(),
            },
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::body::Body;

    #[tokio::test]
    async fn deadline_rejects_slow_work() {
        let outcome = with_deadline(Some(Duration::from_millis(10)), async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            "late"
        })
        .await;
        assert!(outcome.is_err());
    }

    #[tokio::test]
    async fn deadline_allows_fast_work() {
        let outcome = with_deadline(Some(Duration::from_millis(1_000)), async { "on time" }).await;
        assert_eq!(outcome.ok(), Some("on time"));
    }

    #[test]
    fn oversized_responses_fall_back_to_a_bounded_error() {
        let oversized = "x".repeat(MAX_BODY_BYTES + 1);
        let response = json(StatusCode::OK, &oversized);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            response.body().clone().size_hint().upper().unwrap_or(0) <= MAX_BODY_BYTES as u64,
            "fallback body must stay within the protocol cap"
        );
    }
}
