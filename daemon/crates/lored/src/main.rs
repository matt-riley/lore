//! `lored` — the Lore v2 daemon. G1 proof: `POST /v2/status` over a Unix
//! socket with the contract envelope, Host and deadline validation.
//!
//! Deliberately absent from this scaffold: storage, identity locks, other
//! routes, cancellation and the full Status surface. See `daemon/README.md`.

use std::convert::Infallible;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

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

use protocol::{
    API_MAJOR, API_MINOR, Envelope, ErrorDetail, ErrorEnvelope, HOST, MAX_BODY_BYTES, OkEnvelope,
    Readiness, StatusParams, StatusResult, code, reason,
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
}

struct State {
    store_id: String,
    process_instance_id: String,
    started: Instant,
}

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

    let Ok(collected) = Limited::new(request.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
    else {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            code::RESOURCE_EXHAUSTED,
            reason::REQUEST_BYTES,
            false,
            None,
            None,
        );
    };
    let Ok(envelope) = serde_json::from_slice::<Envelope<StatusParams>>(&collected.to_bytes())
    else {
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
    if envelope.meta.timeout_ms == Some(0) {
        return error(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_DEADLINE,
            false,
            Some(&request_id),
            Some(&state.store_id),
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
            Some(&state.store_id),
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
            Some(&state.store_id),
        );
    }

    json(
        StatusCode::OK,
        &OkEnvelope {
            ok: true,
            request_id,
            store_id: state.store_id.clone(),
            result: StatusResult {
                api_major: API_MAJOR,
                api_minor: API_MINOR,
                daemon_version: env!("CARGO_PKG_VERSION").to_string(),
                schema_version: 1,
                store_id: state.store_id.clone(),
                process_instance_id: state.process_instance_id.clone(),
                uptime_ms: state.started.elapsed().as_millis() as u64,
                readiness: Readiness::Ready,
                capabilities: vec!["status.basic".to_string()],
            },
        },
    )
}

fn json<T: Serialize>(status: StatusCode, value: &T) -> Resp {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
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
