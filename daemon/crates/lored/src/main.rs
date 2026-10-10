//! `lored` — the Lore v2 daemon.
//!
//! Stage 2: durable Status, Retain, Forget and lexical Recall over a Unix
//! socket, with store/endpoint ownership, bounded foreground admission and
//! crash-safe acknowledgements.

use std::collections::HashMap;
use std::convert::Infallible;
use std::error::Error as _;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use bytes::Bytes;
use clap::Parser;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use lore_core::config::{ResolvedAnalysis, ResolvedConfig, ResolvedEmbedding, ResolvedMaintenance};
use lore_core::error::CoreError;
use lore_core::lifecycle;
use lore_core::policy;
use lore_core::store::{EmbeddingCounts, OnboardInput, SemanticInput, Store};
use lore_provider::{EmbeddingProvider, ProviderIdentity};
use tokio::sync::Notify;

use semantics::{QueryOutcome, Semantics};
use worker::{WorkerState, spawn as spawn_worker};

mod maintenance;
mod semantics;
mod sources;
mod watchdog;
mod worker;
use protocol::{
    API_MAJOR, API_MINOR, AdminParams, BODY_DEADLINE_MS, ConfigReloadParams, ConfigReloadResult,
    EmbeddingStatus, Envelope, ErrorDetail, ErrorEnvelope, ForgetParams, HOST, JobCounts,
    JobRecord, JobsRetryParams, JobsRetryResult, JobsStatusParams, JobsStatusResult,
    MAX_BODY_BYTES, MAX_TIMEOUT_MS, OkEnvelope, Readiness, RecallParams, RequestMeta, RetainParams,
    StatusCounts, StatusParams, StatusQueue, StatusResult, ViewParams, code, reason,
};

use sources::Scheduler;

type Resp = Response<Full<Bytes>>;

/// Foreground request limit (configuration-storage: active foreground work 32).
const FOREGROUND_LIMIT: usize = 32;
/// Per-client foreground share (configuration-storage: 8 requests).
const CLIENT_SHARE: usize = 8;
/// Status work budget (configuration-storage: 100 ms).
const STATUS_BUDGET_MS: u64 = 100;
/// Shutdown drain budget.
const DRAIN_MS: u64 = 5_000;

#[derive(Debug, Parser)]
#[command(name = "lored", version, about = "Lore v2 daemon")]
struct Args {
    /// v2 configuration file.
    #[arg(long, env = "LORE_V2_CONFIG")]
    config: Option<PathBuf>,
    /// Managed data directory (overrides config).
    #[arg(long, env = "LORE_V2_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Unix socket path (overrides config).
    ///
    /// Deliberately not read from LORE_V2_SOCKET: that variable tells *clients*
    /// where to connect, and a daemon that honoured it would let any inherited
    /// shell environment move its endpoint (two daemons then fight over one
    /// lock file). The config is authoritative for the daemon.
    #[arg(long)]
    socket: Option<PathBuf>,
    /// Concurrent foreground request limit.
    #[arg(long, env = "LORE_V2_MAX_INFLIGHT", default_value_t = FOREGROUND_LIMIT)]
    max_inflight: usize,
}

struct State {
    store: Arc<Store>,
    store_id: String,
    enabled: bool,
    config: ResolvedConfig,
    process_instance_id: String,
    started: Instant,
    inflight: Arc<Semaphore>,
    /// Slots for blocking store work. A timed-out request cannot cancel its
    /// SQLite closure, so the slot is held until that closure returns.
    blocking: Arc<Semaphore>,
    max_inflight: usize,
    clients: Mutex<HashMap<String, usize>>,
    semantics: Arc<Semantics>,
    worker_state: Arc<WorkerState>,
    notify: Arc<Notify>,
    scheduler: Scheduler,
    unavailable_reason: Option<String>,
    generation: AtomicU32,
    config_path: Option<PathBuf>,
    maintenance: Arc<ResolvedMaintenance>,
    analysis: Arc<Option<ResolvedAnalysis>>,
    chat_lane: Arc<Semaphore>,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let args = Args::parse();
    let config = ResolvedConfig::load(
        args.config.as_deref(),
        args.data_dir.as_deref(),
        args.socket.as_deref(),
    )
    .map_err(to_anyhow)?;

    let _store_lock = lifecycle::try_lock(
        &lifecycle::store_lock_path(&config.data_dir),
        "STORE_IN_USE",
    )
    .map_err(to_anyhow)?;
    let endpoint_lock_path = PathBuf::from(format!("{}.lock", config.socket_path.display()));
    let _endpoint_lock =
        lifecycle::try_lock(&endpoint_lock_path, "ENDPOINT_IN_USE").map_err(to_anyhow)?;
    prepare_endpoint(&config.socket_path).map_err(to_anyhow)?;

    let store = Arc::new(Store::open(&config).map_err(to_anyhow)?);
    let initial = store.status().map_err(to_anyhow)?;

    // Install signal handlers before the socket exists: a caller that sees
    // the endpoint must never observe default SIGTERM handling, or a clean
    // stop during startup would kill the process with signal 15.
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("install SIGTERM handler")?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .context("install SIGINT handler")?;

    let listener = UnixListener::bind(&config.socket_path)
        .with_context(|| format!("bind {}", config.socket_path.display()))?;
    std::fs::set_permissions(&config.socket_path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod {}", config.socket_path.display()))?;
    let bound_inode = std::fs::metadata(&config.socket_path)
        .context("stat bound socket")?
        .ino();

    let max_inflight = args.max_inflight.max(1);
    let provider = match &config.embedding {
        Some(embedding) => Some(Arc::new(build_provider(embedding).map_err(to_anyhow)?)),
        None => None,
    };
    let min_similarity = config
        .embedding
        .as_ref()
        .map(|embedding| embedding.min_similarity)
        .unwrap_or(0.0);
    let semantics = Arc::new(Semantics::new(
        provider,
        config.embedding_identity.clone(),
        min_similarity,
    ));
    let worker_state = Arc::new(WorkerState::new());
    let notify = Arc::new(Notify::new());
    let worker_handle = if config.embedding.is_some() {
        let handle = spawn_worker(
            Arc::clone(&semantics),
            Arc::clone(&store),
            Arc::clone(&notify),
            Arc::clone(&worker_state),
        );
        notify.notify_one();
        Some(handle)
    } else {
        None
    };
    let generation = config
        .embedding
        .as_ref()
        .map(|embedding| embedding.generation)
        .unwrap_or(0);
    let scheduler = sources::spawn(Arc::clone(&store), config.clone());
    scheduler.wake();
    // A wedged store must not leave a daemon that answers nothing.
    watchdog::spawn(Arc::clone(&store));
    let maintenance_config =
        ResolvedMaintenance::load(config.config_path.as_deref()).map_err(to_anyhow)?;
    let analysis_config =
        ResolvedAnalysis::load(config.config_path.as_deref()).map_err(to_anyhow)?;
    if config.enabled {
        // Disabled stores serve Status only and never run background work.
        maintenance::spawn(
            Arc::clone(&store),
            maintenance_config.clone(),
            lore_core::store::DEFAULT_MAINTENANCE_SCOPE.to_string(),
        );
    }
    let unavailable_reason = match store.migration_state().map_err(to_anyhow)?.as_deref() {
        Some("validated") | Some("complete") | None => None,
        Some(_) => Some("MIGRATION_INCOMPLETE".to_string()),
    };
    let state = Arc::new(State {
        store,
        store_id: initial.store_id,
        enabled: config.enabled,
        config: config.clone(),
        process_instance_id: Uuid::new_v4().to_string(),
        started: Instant::now(),
        inflight: Arc::new(Semaphore::new(max_inflight)),
        blocking: Arc::new(Semaphore::new(max_inflight)),
        max_inflight,
        clients: Mutex::new(HashMap::new()),
        semantics,
        worker_state,
        notify,
        scheduler,
        unavailable_reason,
        generation: AtomicU32::new(generation),
        config_path: config.config_path.clone(),
        maintenance: Arc::new(maintenance_config),
        analysis: Arc::new(analysis_config.enabled.then_some(analysis_config)),
        chat_lane: Arc::new(Semaphore::new(1)),
    });
    eprintln!(
        "[lored] listening on {} (store {})",
        config.socket_path.display(),
        state.store_id
    );

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.context("accept")?;
                let state = Arc::clone(&state);
                tokio::spawn(async move { serve(stream, state).await });
            }
            _ = interrupt.recv() => break,
            _ = terminate.recv() => break,
        }
    }

    eprintln!("[lored] draining");
    drop(listener);
    let drain_deadline = Instant::now() + Duration::from_millis(DRAIN_MS);
    while state.inflight.available_permits() < state.max_inflight && Instant::now() < drain_deadline
    {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if let Ok(metadata) = std::fs::metadata(&config.socket_path)
        && metadata.ino() == bound_inode
    {
        let _ = std::fs::remove_file(&config.socket_path);
    }
    if let Some(handle) = worker_handle {
        handle.abort();
    }
    Ok(())
}

fn build_provider(embedding: &ResolvedEmbedding) -> Result<EmbeddingProvider, CoreError> {
    let identity = ProviderIdentity::new(
        &embedding.endpoint,
        &embedding.model,
        embedding.generation,
        embedding.dimensions,
    )
    .map_err(|error| CoreError::invalid(error.category(), error.to_string()))?;
    EmbeddingProvider::new(
        identity,
        &embedding.endpoint,
        Duration::from_millis(embedding.timeout_ms),
    )
    .map_err(|error| CoreError::invalid(error.category(), error.to_string()))
}

/// Validate or clear an existing endpoint before binding.
fn prepare_endpoint(path: &Path) -> Result<(), CoreError> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CoreError::internal("IO_FAILURE", format!("{error}"))),
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_socket() {
                return Err(CoreError::precondition(
                    "UNSAFE_PATH",
                    format!("endpoint is not an owned socket: {}", path.display()),
                ));
            }
            match std::os::unix::net::UnixStream::connect(path) {
                Ok(_) => Err(CoreError::precondition(
                    "ENDPOINT_IN_USE",
                    "a live responder owns this endpoint",
                )),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                    ) =>
                {
                    std::fs::remove_file(path).map_err(CoreError::from)
                }
                Err(_) => Err(CoreError::precondition(
                    "ENDPOINT_IN_USE",
                    "endpoint could not be validated as stale",
                )),
            }
        }
    }
}

fn to_anyhow(error: CoreError) -> anyhow::Error {
    anyhow::anyhow!("{}: {} ({})", error.code, error.message, error.reason)
}

async fn serve(stream: UnixStream, state: Arc<State>) {
    let service = service_fn(move |request| {
        let state = Arc::clone(&state);
        async move { Ok::<Resp, Infallible>(handle(request, state).await) }
    });
    let outcome = http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .await;
    if let Err(error) = outcome
        && !is_client_close(&error)
    {
        eprintln!("[lored] connection error: {error}");
    }
}

/// The client went away: either it closed a keep-alive connection after the
/// response (hyper reports the failed shutdown as "not connected") or it
/// abandoned a request mid-flight. Neither is a server fault, so neither is
/// logged.
fn is_client_close(error: &hyper::Error) -> bool {
    if error.is_incomplete_message() {
        return true;
    }
    error.is_shutdown()
        && error
            .source()
            .and_then(|cause| cause.downcast_ref::<std::io::Error>())
            .is_some_and(|io| {
                matches!(
                    io.kind(),
                    std::io::ErrorKind::NotConnected
                        | std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionReset
                )
            })
}

async fn handle(request: Request<Incoming>, state: Arc<State>) -> Resp {
    if request.method() != Method::POST {
        let mut response = fail_response(
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
    let path = request.uri().path().to_string();
    let view = path
        .strip_prefix("/v2/views/")
        .map(str::to_string)
        .filter(|name| !name.contains(".."));
    let admin = path
        .strip_prefix("/v2/admin/")
        .map(str::to_string)
        .filter(|name| !name.contains(".."));
    if view.is_none()
        && admin.is_none()
        && !matches!(
            path.as_str(),
            "/v2/status"
                | "/v2/retain"
                | "/v2/forget"
                | "/v2/recall"
                | "/v2/jobs/status"
                | "/v2/jobs/retry"
                | "/v2/config/reload"
                | "/v2/sources/register"
                | "/v2/sources/hint"
                | "/v2/sources/status"
                | "/v2/extraction/retry"
                | "/v2/analysis"
        )
    {
        return fail_response(
            StatusCode::NOT_IMPLEMENTED,
            code::UNIMPLEMENTED,
            reason::ROUTE_UNIMPLEMENTED,
            false,
            None,
            None,
        );
    }
    if admin.is_some() && !lore_core::store::known_admin(admin.as_deref().unwrap_or("")) {
        return fail_response(
            StatusCode::NOT_IMPLEMENTED,
            code::UNIMPLEMENTED,
            reason::ROUTE_UNIMPLEMENTED,
            false,
            None,
            None,
        );
    }
    if view.is_some() && !lore_core::store::known_view(view.as_deref().unwrap_or("")) {
        return fail_response(
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
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_HOST,
            false,
            None,
            None,
        );
    }
    if request.headers().contains_key(hyper::header::ORIGIN) {
        return fail_response(
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
        return fail_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            code::INVALID_ARGUMENT,
            reason::UNSUPPORTED_MEDIA_TYPE,
            false,
            None,
            None,
        );
    }

    let Ok(_permit) = Arc::clone(&state.inflight).try_acquire_owned() else {
        return fail_response(
            StatusCode::TOO_MANY_REQUESTS,
            code::RESOURCE_EXHAUSTED,
            reason::REQUEST_CAPACITY,
            true,
            None,
            Some(&state.store_id),
        );
    };

    let collected = match tokio::time::timeout(
        Duration::from_millis(BODY_DEADLINE_MS),
        Limited::new(request.into_body(), MAX_BODY_BYTES).collect(),
    )
    .await
    {
        Err(_) => {
            return fail_response(
                StatusCode::REQUEST_TIMEOUT,
                code::DEADLINE_EXCEEDED,
                reason::REQUEST_TIMEOUT,
                true,
                None,
                None,
            );
        }
        Ok(Err(_)) => {
            return fail_response(
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

    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_JSON,
            false,
            None,
            None,
        );
    };
    let request_id = value
        .pointer("/meta/requestId")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    if protocol::has_unsafe_integer(&value) {
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::UNSAFE_INTEGER,
            false,
            request_id.as_deref(),
            Some(&state.store_id),
        );
    }

    match path.as_str() {
        _ if view.is_some() => handle_view(&raw, &state, request_id, view.unwrap()).await,
        _ if admin.is_some() => handle_admin(&raw, &state, request_id, admin.unwrap()).await,
        "/v2/status" => handle_status(&raw, &state, request_id).await,
        "/v2/retain" => handle_retain(&raw, &state, request_id).await,
        "/v2/forget" => handle_forget(&raw, &state, request_id).await,
        "/v2/jobs/status" => handle_jobs_status(&raw, &state, request_id).await,
        "/v2/jobs/retry" => handle_jobs_retry(&raw, &state, request_id).await,
        "/v2/config/reload" => handle_config_reload(&raw, &state, request_id).await,
        "/v2/sources/register" => sources::handle_register(&raw, &state, request_id).await,
        "/v2/sources/hint" => sources::handle_hint(&raw, &state, request_id).await,
        "/v2/sources/status" => sources::handle_status(&raw, &state, request_id).await,
        "/v2/extraction/retry" => sources::handle_extraction_retry(&raw, &state, request_id).await,
        "/v2/analysis" => handle_analysis(&raw, &state, request_id).await,
        _ => handle_recall(&raw, &state, request_id).await,
    }
}

#[allow(clippy::result_large_err)]
fn parse_route<P: DeserializeOwned + Default>(
    raw: &[u8],
    request_id: Option<&str>,
    store_id: &str,
) -> Result<Envelope<P>, Resp> {
    serde_json::from_slice::<Envelope<P>>(raw).map_err(|_| {
        fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_JSON,
            false,
            request_id,
            Some(store_id),
        )
    })
}

fn require_store(meta: &RequestMeta, store_id: &str, required: bool) -> Option<Resp> {
    match meta.expected_store_id.as_deref() {
        None if required => Some(fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            "STORE_ID_REQUIRED",
            false,
            Some(&meta.request_id),
            Some(store_id),
        )),
        Some(expected) if expected != store_id => Some(fail_response(
            StatusCode::PRECONDITION_FAILED,
            code::FAILED_PRECONDITION,
            reason::STORE_MISMATCH,
            false,
            Some(&meta.request_id),
            Some(store_id),
        )),
        _ => None,
    }
}

fn disabled_response(meta: &RequestMeta, store_id: &str, reason: &str) -> Resp {
    fail_response(
        StatusCode::PRECONDITION_FAILED,
        code::FAILED_PRECONDITION,
        reason,
        false,
        Some(&meta.request_id),
        Some(store_id),
    )
}

/// Unavailable reason for this process: disabled config or an unfinished
/// migration import that must not serve writes.
fn unavailable_reason(state: &Arc<State>) -> Option<String> {
    state.unavailable_reason.clone()
}

fn core_response(error: CoreError, request_id: &str, store_id: &str) -> Resp {
    fail_response(
        StatusCode::from_u16(error.http).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        &error.code,
        &error.reason,
        error.retryable,
        Some(request_id),
        Some(store_id),
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn effective_deadline(meta: &RequestMeta, maximum_ms: u64) -> Duration {
    Duration::from_millis(meta.timeout_ms.unwrap_or(maximum_ms).clamp(1, maximum_ms))
}

struct ClientGuard {
    state: Arc<State>,
    client_id: String,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        let mut clients = self.state.clients.lock().expect("client map");
        if let Some(count) = clients.get_mut(&self.client_id) {
            *count -= 1;
            if *count == 0 {
                clients.remove(&self.client_id);
            }
        }
    }
}

/// Admission for one blocking store call. The returned permit must move into
/// the closure: a deadline drops the awaiting future, but the closure keeps
/// running, and its capacity must stay accounted for until it actually exits.
#[allow(clippy::result_large_err)]
fn blocking_slot(state: &State, request_id: Option<&str>) -> Result<OwnedSemaphorePermit, Resp> {
    Arc::clone(&state.blocking)
        .try_acquire_owned()
        .map_err(|_| {
            fail_response(
                StatusCode::TOO_MANY_REQUESTS,
                code::RESOURCE_EXHAUSTED,
                reason::REQUEST_CAPACITY,
                true,
                request_id,
                Some(&state.store_id),
            )
        })
}

#[allow(clippy::result_large_err)]
fn acquire_client(client_id: &str, state: &Arc<State>) -> Result<ClientGuard, Resp> {
    let mut clients = state.clients.lock().expect("client map");
    let count = clients.entry(client_id.to_string()).or_insert(0);
    if *count >= CLIENT_SHARE {
        return Err(fail_response(
            StatusCode::TOO_MANY_REQUESTS,
            code::RESOURCE_EXHAUSTED,
            "CLIENT_CAPACITY",
            true,
            None,
            Some(&state.store_id),
        ));
    }
    *count += 1;
    Ok(ClientGuard {
        state: Arc::clone(state),
        client_id: client_id.to_string(),
    })
}

async fn handle_status(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    let envelope = match parse_route::<StatusParams>(raw, fallback_id.as_deref(), &state.store_id) {
        Ok(envelope) => envelope,
        Err(response) => return response,
    };
    let request_id = envelope.meta.request_id.clone();
    let store_id = state.store_id.clone();
    if envelope.meta.timeout_ms == Some(0) {
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_DEADLINE,
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }
    if let Some(response) = require_store(&envelope.meta, &store_id, false) {
        return response;
    }
    if let Some(expected) = envelope.params.expected_api_major
        && expected != API_MAJOR
    {
        return fail_response(
            StatusCode::PRECONDITION_FAILED,
            code::FAILED_PRECONDITION,
            reason::API_MAJOR_MISMATCH,
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }

    let slot = match blocking_slot(state, Some(&request_id)) {
        Ok(slot) => slot,
        Err(response) => return response,
    };
    let store = Arc::clone(&state.store);
    let identity = state.semantics.identity();
    let now = now_ms();
    let work = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let status = store.status()?;
        let counts = match &identity {
            Some(identity) => store.embedding_counts(identity, now)?,
            None => EmbeddingCounts::default(),
        };
        Ok::<_, CoreError>((status, counts))
    });
    let budget = Duration::from_millis(
        envelope
            .meta
            .timeout_ms
            .unwrap_or(STATUS_BUDGET_MS)
            .clamp(1, STATUS_BUDGET_MS),
    );
    match tokio::time::timeout(budget, work).await {
        Err(_) => fail_response(
            StatusCode::GATEWAY_TIMEOUT,
            code::DEADLINE_EXCEEDED,
            reason::REQUEST_DEADLINE,
            true,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(Err(_)) => fail_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            code::INTERNAL,
            reason::INTERNAL_FAILURE,
            false,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(Ok(Err(error))) => core_response(error, &request_id, &store_id),
        Ok(Ok(Ok((status, counts)))) => {
            let mut capabilities = vec![
                "status.basic".to_string(),
                "memory.retain.manual".to_string(),
                "memory.forget".to_string(),
                "recall.lexical".to_string(),
            ];
            if state.semantics.identity().is_some() {
                capabilities.push("recall.semantic.bounded".to_string());
                capabilities.push("embedding.status".to_string());
                capabilities.push("embedding.retry".to_string());
                capabilities.push("config.reload".to_string());
            }
            // Source, extraction and view capabilities exist regardless of
            // configured roots; views are always read-only.
            capabilities.push("sources.register".to_string());
            capabilities.push("sources.hint".to_string());
            capabilities.push("sources.status".to_string());
            capabilities.push("extraction.retry".to_string());
            capabilities.push("views.read".to_string());
            capabilities.push("search.browse".to_string());
            capabilities.push("explain.context".to_string());
            capabilities.push("validate.read".to_string());
            capabilities.push("doctor.read".to_string());
            capabilities.push("audit.read".to_string());
            capabilities.push("memory.correct".to_string());
            capabilities.push("memory.purge".to_string());
            capabilities.push("memory.scope.override".to_string());
            capabilities.push("memory.scope.audit".to_string());
            capabilities.push("operations.runs".to_string());
            capabilities.push("memory.onboard".to_string());
            capabilities.push("memory.maintenance".to_string());
            capabilities.push("memory.reflect".to_string());
            capabilities.push("memory.deferred.process".to_string());
            capabilities.push("memory.backfill".to_string());
            capabilities.push("memory.backlog".to_string());
            capabilities.push("memory.ledger".to_string());
            capabilities.push("memory.journal".to_string());
            capabilities.push("memory.review.gate".to_string());
            capabilities.push("memory.bundle".to_string());
            capabilities.push("memory.skill.validate".to_string());
            capabilities.push("memory.repair".to_string());
            capabilities.push("memory.replay".to_string());
            if state.analysis.is_some() {
                capabilities.push("analysis.chat".to_string());
            }
            if matches!(&*state.analysis, Some(analysis) if analysis.rerank) {
                capabilities.push("recall.rerank".to_string());
            }
            if !state.enabled || unavailable_reason(state).is_some() {
                capabilities = vec!["status.basic".to_string()];
            }
            json(
                StatusCode::OK,
                &OkEnvelope {
                    ok: true,
                    request_id,
                    store_id,
                    result: StatusResult {
                        api_major: API_MAJOR,
                        api_minor: API_MINOR,
                        daemon_version: env!("CARGO_PKG_VERSION").to_string(),
                        schema_version: 10,
                        store_id: state.store_id.clone(),
                        process_instance_id: state.process_instance_id.clone(),
                        uptime_ms: state.started.elapsed().as_millis() as u64,
                        readiness: if state.enabled && unavailable_reason(state).is_none() {
                            Readiness::Ready
                        } else {
                            Readiness::Unavailable
                        },
                        reason: if let Some(reason) = unavailable_reason(state) {
                            Some(reason)
                        } else if state.enabled {
                            None
                        } else {
                            Some("CONFIG_DISABLED".to_string())
                        },
                        capabilities,
                        memory_revision: status.memory_revision.to_string(),
                        derived_generation: status.derived_generation.to_string(),
                        counts: StatusCounts {
                            active_memories: status.active_memories.to_string(),
                            forgotten_memories: status.forgotten_memories.to_string(),
                            receipts: status.receipts.to_string(),
                        },
                        queue: StatusQueue {
                            queued: counts.queued.to_string(),
                            running: counts.running.to_string(),
                        },
                        embedding: EmbeddingStatus {
                            provider: state
                                .config
                                .embedding
                                .as_ref()
                                .map(|embedding| embedding.display.clone()),
                            state: if state.config.embedding.is_none() {
                                "disabled".to_string()
                            } else {
                                state.worker_state.status()
                            },
                            dimensions: state
                                .config
                                .embedding
                                .as_ref()
                                .map(|embedding| embedding.dimensions as u64)
                                .unwrap_or(0),
                            coverage_current: counts.current_vectors.to_string(),
                            coverage_eligible: counts.eligible_memories.to_string(),
                            pending: counts.pending.to_string(),
                            failed: counts.failed.to_string(),
                            oldest_pending_ms: counts.oldest_pending_ms,
                            last_error: state.worker_state.last_error(),
                        },
                        sources: sources::source_summary(&state.store).unwrap_or(
                            protocol::SourceStatusCounts {
                                discovered: 0,
                                caught_up: 0,
                                growing: 0,
                                unavailable: 0,
                                ambiguous: 0,
                                failed: 0,
                                skipped: 0,
                            },
                        ),
                    },
                },
            )
        }
    }
}

async fn handle_retain(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    let envelope = match parse_route::<RetainParams>(raw, fallback_id.as_deref(), &state.store_id) {
        Ok(envelope) => envelope,
        Err(response) => return response,
    };
    let request_id = envelope.meta.request_id.clone();
    let store_id = state.store_id.clone();
    if envelope.meta.timeout_ms == Some(0) {
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_DEADLINE,
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }
    if let Some(response) = require_store(&envelope.meta, &store_id, true) {
        return response;
    }
    if !state.enabled || unavailable_reason(state).is_some() {
        return disabled_response(
            &envelope.meta,
            &store_id,
            unavailable_reason(state)
                .as_deref()
                .unwrap_or("CONFIG_DISABLED"),
        );
    }
    if let Err(error) = policy::validate_retain(&envelope.params, &state.config.limits) {
        return core_response(error, &request_id, &store_id);
    }
    let _guard = match acquire_client(&envelope.meta.client_id, state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };

    let store = Arc::clone(&state.store);
    let client_id = envelope.meta.client_id.clone();
    let params = envelope.params.clone();
    let now = now_ms();
    let slot = match blocking_slot(state, Some(&request_id)) {
        Ok(slot) => slot,
        Err(response) => return response,
    };
    let work = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        store.retain(&client_id, &params, now)
    });
    let deadline = effective_deadline(&envelope.meta, MAX_TIMEOUT_MS);
    match tokio::time::timeout(deadline, work).await {
        Err(_) => fail_response(
            StatusCode::GATEWAY_TIMEOUT,
            code::DEADLINE_EXCEEDED,
            reason::REQUEST_DEADLINE,
            true,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(Err(_)) => fail_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            code::INTERNAL,
            reason::INTERNAL_FAILURE,
            false,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(Ok(Err(error))) => core_response(error, &request_id, &store_id),
        Ok(Ok(Ok(result))) => {
            state.worker_state.mark_dirty();
            state.notify.notify_one();
            json(
                StatusCode::OK,
                &OkEnvelope {
                    ok: true,
                    request_id,
                    store_id,
                    result,
                },
            )
        }
    }
}

async fn handle_forget(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    let envelope = match parse_route::<ForgetParams>(raw, fallback_id.as_deref(), &state.store_id) {
        Ok(envelope) => envelope,
        Err(response) => return response,
    };
    let request_id = envelope.meta.request_id.clone();
    let store_id = state.store_id.clone();
    if envelope.meta.timeout_ms == Some(0) {
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_DEADLINE,
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }
    if let Some(response) = require_store(&envelope.meta, &store_id, true) {
        return response;
    }
    if !state.enabled || unavailable_reason(state).is_some() {
        return disabled_response(
            &envelope.meta,
            &store_id,
            unavailable_reason(state)
                .as_deref()
                .unwrap_or("CONFIG_DISABLED"),
        );
    }
    if let Err(error) = policy::validate_forget(envelope.params.reason.as_deref()) {
        return core_response(error, &request_id, &store_id);
    }
    let _guard = match acquire_client(&envelope.meta.client_id, state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };

    let store = Arc::clone(&state.store);
    let client_id = envelope.meta.client_id.clone();
    let params = envelope.params.clone();
    let now = now_ms();
    let slot = match blocking_slot(state, Some(&request_id)) {
        Ok(slot) => slot,
        Err(response) => return response,
    };
    let work = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        store.forget(&client_id, &params, now)
    });
    let deadline = effective_deadline(&envelope.meta, MAX_TIMEOUT_MS);
    match tokio::time::timeout(deadline, work).await {
        Err(_) => fail_response(
            StatusCode::GATEWAY_TIMEOUT,
            code::DEADLINE_EXCEEDED,
            reason::REQUEST_DEADLINE,
            true,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(Err(_)) => fail_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            code::INTERNAL,
            reason::INTERNAL_FAILURE,
            false,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(Ok(Err(error))) => core_response(error, &request_id, &store_id),
        Ok(Ok(Ok(result))) => json(
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

async fn handle_recall(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    let envelope = match parse_route::<RecallParams>(raw, fallback_id.as_deref(), &state.store_id) {
        Ok(envelope) => envelope,
        Err(response) => return response,
    };
    let request_id = envelope.meta.request_id.clone();
    let store_id = state.store_id.clone();
    if envelope.meta.timeout_ms == Some(0) {
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            reason::INVALID_DEADLINE,
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }
    if let Some(response) = require_store(&envelope.meta, &store_id, true) {
        return response;
    }
    if !state.enabled || unavailable_reason(state).is_some() {
        return disabled_response(
            &envelope.meta,
            &store_id,
            unavailable_reason(state)
                .as_deref()
                .unwrap_or("CONFIG_DISABLED"),
        );
    }
    let (limit, context_bytes) =
        match policy::resolve_recall(&envelope.params, &state.config.limits) {
            Ok(resolved) => resolved,
            Err(error) => return core_response(error, &request_id, &store_id),
        };
    let _guard = match acquire_client(&envelope.meta.client_id, state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };

    let server_ms = state.config.limits.recall_server_ms.max(1);
    let budget_ms = envelope
        .meta
        .timeout_ms
        .unwrap_or(server_ms)
        .clamp(1, server_ms);
    let request_start = Instant::now();
    let deadline = request_start + Duration::from_millis(budget_ms);
    let now = now_ms();
    let store = Arc::clone(&state.store);
    let params = envelope.params.clone();

    // Speculative lexical snapshot runs while inference is attempted.
    let lexical_store = Arc::clone(&store);
    let lexical_params = params.clone();
    let speculative = tokio::task::spawn_blocking(move || {
        lexical_store.lexical_snapshot(&lexical_params, now, Some(deadline))
    })
    .await;
    let speculative = match speculative {
        Ok(Ok(snapshot)) => Some(snapshot),
        _ => None,
    };

    // Bounded query inference: exact cache first, then one provider call.
    let remaining_ms = budget_ms.saturating_sub(request_start.elapsed().as_millis() as u64);
    let allowance = Semantics::allowance_ms(remaining_ms);
    let outcome = if state.semantics.identity().is_none() {
        QueryOutcome {
            vector: None,
            cache: "disabled",
            fallback: Some("DISABLED".to_string()),
        }
    } else if allowance == 0 {
        QueryOutcome {
            vector: None,
            cache: "miss",
            fallback: Some("QUERY_BUDGET".to_string()),
        }
    } else {
        let key = state.semantics.cache_key(
            &params.query,
            params.repository.as_deref(),
            params.include_other_repositories,
        );
        state
            .semantics
            .query_vector(&key, &params.query, allowance)
            .await
    };

    let identity = state.semantics.identity().unwrap_or_default();
    let min_similarity = state.semantics.min_similarity();
    let vector = outcome.vector.clone();
    let fallback = outcome.fallback.clone();
    let cache_state = outcome.cache.to_string();

    let final_store = Arc::clone(&store);
    let final_params = params.clone();
    let slot = match blocking_slot(state, Some(&request_id)) {
        Ok(slot) => slot,
        Err(response) => return response,
    };
    let work = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let semantic = SemanticInput {
            identity: &identity,
            vector: vector.as_deref(),
            min_similarity,
            fallback_reason: fallback.as_deref(),
            cache_state: &cache_state,
        };
        final_store.recall_fused(
            &final_params,
            now,
            limit,
            context_bytes,
            speculative.as_ref(),
            semantic,
            Some(deadline),
        )
    });
    match tokio::time::timeout(Duration::from_millis(budget_ms + 250), work).await {
        Err(_) => fail_response(
            StatusCode::GATEWAY_TIMEOUT,
            code::DEADLINE_EXCEEDED,
            reason::REQUEST_DEADLINE,
            true,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(Err(_)) => fail_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            code::INTERNAL,
            reason::INTERNAL_FAILURE,
            false,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(Ok(Err(error))) => core_response(error, &request_id, &store_id),
        Ok(Ok(Ok(result))) => {
            let value = match serde_json::to_value(&result) {
                Ok(value) => value,
                Err(error) => {
                    return core_response(
                        CoreError::internal("INTERNAL", error.to_string()),
                        &request_id,
                        &store_id,
                    );
                }
            };
            let value = apply_rerank(state, &params.query, value).await;
            json(
                StatusCode::OK,
                &OkEnvelope {
                    ok: true,
                    request_id,
                    store_id,
                    result: value,
                },
            )
        }
    }
}

async fn handle_admin(
    raw: &[u8],
    state: &Arc<State>,
    fallback_id: Option<String>,
    operation: String,
) -> Resp {
    let envelope = match parse_route::<AdminParams>(raw, fallback_id.as_deref(), &state.store_id) {
        Ok(envelope) => envelope,
        Err(response) => return response,
    };
    let request_id = envelope.meta.request_id.clone();
    let store_id = state.store_id.clone();
    if let Some(response) = require_store(&envelope.meta, &store_id, true) {
        return response;
    }
    let params = envelope.params.clone();
    let store = Arc::clone(&state.store);
    let shared = Arc::clone(state);
    let runtime = tokio::runtime::Handle::current();
    let now = now_ms();
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, CoreError> {
        match operation.as_str() {
            "search" => {
                let query = lore_core::store::require_query(params.query.as_deref())?;
                store.admin_search(
                    &query,
                    params.repository.as_deref(),
                    params.include_other_repositories,
                    params.cursor.as_deref(),
                    params.limit.unwrap_or(lore_core::store::ADMIN_PAGE_DEFAULT),
                    now,
                )
            }
            "explain" => {
                let query = lore_core::store::require_query(params.query.as_deref())?;
                store.admin_explain(
                    &query,
                    params.repository.as_deref(),
                    params.include_other_repositories,
                    params.limit.unwrap_or(6),
                    params.context_bytes.unwrap_or(8 * 1024),
                    now,
                )
            }
            "validate" => store.admin_validate(params.deep),
            "correct" => {
                let memory_id = params.id.clone().ok_or_else(|| {
                    CoreError::invalid("ADMIN_ARGUMENT_INVALID", "correct requires id")
                })?;
                let provider_action = params.action.as_deref().unwrap_or("preview");
                if provider_action == "apply" || params.plan_fingerprint.is_some() {
                    let plan = params.plan_fingerprint.clone().ok_or_else(|| {
                        CoreError::invalid(
                            "ADMIN_ARGUMENT_INVALID",
                            "applying a correction requires planFingerprint",
                        )
                    })?;
                    let outcome = store.correct_apply(
                        &memory_id,
                        params.content.as_deref(),
                        params.kind.as_deref(),
                        params.scope.as_deref(),
                        params.repository.as_deref(),
                        params.expires_at_ms,
                        &plan,
                        params.actor.as_deref(),
                        params.reason.as_deref(),
                        now,
                    )?;
                    serde_json::to_value(outcome)
                        .map_err(|error| CoreError::internal("INTERNAL", error.to_string()))
                } else {
                    store.correct_preview(
                        &memory_id,
                        params.content.as_deref(),
                        params.kind.as_deref(),
                        params.scope.as_deref(),
                        params.repository.as_deref(),
                        params.expires_at_ms,
                    )
                }
            }
            "purge" => {
                let provider_action = params.action.as_deref().unwrap_or("preview");
                if provider_action == "apply" || params.plan_fingerprint.is_some() {
                    let plan = params.plan_fingerprint.clone().ok_or_else(|| {
                        CoreError::invalid(
                            "ADMIN_ARGUMENT_INVALID",
                            "applying a purge requires planFingerprint",
                        )
                    })?;
                    let outcome = store.purge_apply(
                        &params.memory_ids,
                        params.repository.as_deref(),
                        params.global,
                        params.limit,
                        params.include_dependent_aggregates,
                        &plan,
                        params.actor.as_deref(),
                        params.reason.as_deref(),
                        now,
                    )?;
                    serde_json::to_value(outcome)
                        .map_err(|error| CoreError::internal("INTERNAL", error.to_string()))
                } else {
                    store.purge_preview(
                        &params.memory_ids,
                        params.repository.as_deref(),
                        params.global,
                        params.limit,
                        params.include_dependent_aggregates,
                    )
                }
            }
            "scope-override" => {
                let provider_action = params.action.as_deref().unwrap_or("preview");
                let clear = params.clear || provider_action == "clear";
                if provider_action == "apply" || params.plan_fingerprint.is_some() {
                    let plan = params.plan_fingerprint.clone().ok_or_else(|| {
                        CoreError::invalid(
                            "ADMIN_ARGUMENT_INVALID",
                            "applying a scope override requires planFingerprint",
                        )
                    })?;
                    let actor = params.actor.clone().ok_or_else(|| {
                        CoreError::invalid("ADMIN_ARGUMENT_INVALID", "scope override needs actor")
                    })?;
                    let reason = params.reason.clone().ok_or_else(|| {
                        CoreError::invalid("ADMIN_ARGUMENT_INVALID", "scope override needs reason")
                    })?;
                    let outcome = store.scope_override_apply(
                        &params.memory_ids,
                        params.scope.as_deref(),
                        params.repository.as_deref(),
                        clear,
                        &plan,
                        &actor,
                        &reason,
                        now,
                    )?;
                    serde_json::to_value(outcome)
                        .map_err(|error| CoreError::internal("INTERNAL", error.to_string()))
                } else {
                    store.scope_override_preview(
                        &params.memory_ids,
                        params.scope.as_deref(),
                        params.repository.as_deref(),
                        clear,
                    )
                }
            }
            "scope-audit" => store.scope_audit(
                params
                    .cursor
                    .as_deref()
                    .and_then(|value| value.parse().ok()),
                params.limit.unwrap_or(50),
            ),
            "run-status" => {
                let run_id = params.run_id.clone().ok_or_else(|| {
                    CoreError::invalid("ADMIN_ARGUMENT_INVALID", "run-status requires runId")
                })?;
                store.run_status(&run_id, None, params.limit.unwrap_or(50))
            }
            "onboard" => {
                let input = OnboardInput {
                    user_name: params.user_name.clone(),
                    assistant_name: params.assistant_name.clone(),
                    voice: params.voice.clone(),
                    warmth: params.warmth.clone(),
                    humor: params.humor.clone(),
                    humor_frequency: params.humor_frequency.clone(),
                    collaborative: params.collaborative,
                    use_name_naturally: params.use_name_naturally,
                };
                let outcome = store.onboard_apply(&input, now)?;
                serde_json::to_value(outcome)
                    .map_err(|error| CoreError::internal("INTERNAL", error.to_string()))
            }
            "maintenance" => {
                let scope = params
                    .scope
                    .clone()
                    .unwrap_or_else(|| lore_core::store::DEFAULT_MAINTENANCE_SCOPE.to_string());
                match params.action.as_deref() {
                    Some("run") => {
                        let task = params.task.clone().ok_or_else(|| {
                            CoreError::invalid(
                                "ADMIN_ARGUMENT_INVALID",
                                "running a maintenance task needs a task name",
                            )
                        })?;
                        if !lore_core::store::MAINTENANCE_TASK_NAMES.contains(&task.as_str()) {
                            return Err(CoreError::invalid(
                                "ADMIN_ARGUMENT_INVALID",
                                format!("unknown maintenance task: {task}"),
                            ));
                        }
                        store.maintenance_sync(&shared.maintenance, &scope, now)?;
                        let dry_run = params.dry_run;
                        let run_id = store
                            .maintenance_claim(
                                &task,
                                &scope,
                                if dry_run { "manual-dry-run" } else { "manual" },
                                dry_run,
                                now,
                            )?
                            .ok_or_else(|| {
                                CoreError::conflict(
                                    "MAINTENANCE_ALREADY_RUNNING",
                                    "that task already has an active run",
                                )
                            })?;
                        let outcome = maintenance::run_task(&store, &run_id, &task, dry_run, now);
                        store.maintenance_finish(
                            &run_id,
                            outcome.state,
                            outcome.completed,
                            outcome.failed,
                            outcome.needs_attention,
                            Some(outcome.detail.clone()),
                            now,
                        )?;
                        Ok(serde_json::json!({
                            "runId": run_id,
                            "task": task,
                            "scope": scope,
                            "dryRun": dry_run,
                            "state": outcome.state,
                            "counts": {
                                "completed": outcome.completed,
                                "failed": outcome.failed,
                                "needsAttention": outcome.needs_attention,
                            },
                            "detail": outcome.detail,
                        }))
                    }
                    Some("rollback") => {
                        let run_id = params.run_id.clone().ok_or_else(|| {
                            CoreError::invalid("ADMIN_ARGUMENT_INVALID", "rollback needs a runId")
                        })?;
                        let restored = maintenance::rollback_hygiene(&store, &run_id)
                            .map_err(|reason| CoreError::invalid("MAINTENANCE_ROLLBACK", reason))?;
                        Ok(serde_json::json!({ "runId": run_id, "restored": restored }))
                    }
                    _ => {
                        store.maintenance_sync(&shared.maintenance, &scope, now)?;
                        let report = lore_core::store::maintenance_report(
                            &store,
                            std::slice::from_ref(&scope),
                            params.limit.unwrap_or(lore_core::store::ADMIN_PAGE_DEFAULT),
                        )?;
                        Ok(report)
                    }
                }
            }
            "migration-unscoped" => {
                let source = params.source.clone().ok_or_else(|| {
                    CoreError::invalid(
                        "ADMIN_ARGUMENT_INVALID",
                        "an unscoped import needs the v1 database path as `source`",
                    )
                })?;
                let apply = params.action.as_deref() == Some("apply");
                let outcome =
                    store.import_unscoped_as_global(std::path::Path::new(&source), apply, now)?;
                if apply {
                    shared.worker_state.request_resume();
                    shared.notify.notify_one();
                }
                Ok(outcome)
            }
            "reflect" => {
                let query = params.query.as_deref();
                let repository = params.repository.as_deref();
                let limit = params.limit.unwrap_or(20);
                let deterministic = store.reflect(query, repository, limit, false, now)?;
                let mut value = serde_json::to_value(&deterministic)
                    .map_err(|error| CoreError::internal("INTERNAL", error.to_string()))?;
                let mut synthesis = "deterministic";
                let mut fallback_reason: Option<String> = None;
                let mut chosen_text = deterministic.text.clone();
                if params.mode.as_deref() == Some("chat") && !deterministic.memory_ids.is_empty() {
                    // The provider call is async; this closure is a blocking
                    // task, so drive it with the captured runtime handle.
                    match runtime.block_on(analysis_synthesis(
                        &shared,
                        query.unwrap_or(""),
                        &deterministic.text,
                        &deterministic.memory_ids,
                    )) {
                        Ok(text) => {
                            synthesis = "chat";
                            chosen_text = text;
                        }
                        Err(reason) => {
                            fallback_reason = Some(reason);
                        }
                    }
                }
                if params.persist {
                    let persisted = store.reflect_with_text(
                        query,
                        repository,
                        limit,
                        true,
                        Some(&chosen_text),
                        now,
                    )?;
                    value["persisted"] =
                        serde_json::to_value(persisted.persisted).unwrap_or(Value::Null);
                    value["committedRevision"] =
                        serde_json::to_value(persisted.committed_revision).unwrap_or(Value::Null);
                }
                value["text"] = Value::String(chosen_text);
                value["synthesis"] = Value::String(synthesis.to_string());
                value["fallbackReason"] = fallback_reason.map(Value::String).unwrap_or(Value::Null);
                Ok(value)
            }
            "deferred-process" => {
                let limit = params.limit.unwrap_or(16).min(64) as usize;
                let report = crate::sources::extract_pending(&store, limit, now);
                serde_json::to_value(report)
                    .map_err(|error| CoreError::internal("INTERNAL", error.to_string()))
            }
            "backfill" => {
                let report = crate::sources::run_sweep(&store, &shared.config, now);
                serde_json::to_value(report)
                    .map_err(|error| CoreError::internal("INTERNAL", error.to_string()))
            }
            "backlog" => match params.action.as_deref().unwrap_or("list") {
                "add" => {
                    let title = params.title.clone().ok_or_else(|| {
                        CoreError::invalid("ADMIN_ARGUMENT_INVALID", "backlog add needs a title")
                    })?;
                    store.backlog_add(
                        params.id.as_deref(),
                        params.kind.as_deref().unwrap_or("improvement"),
                        &title,
                        params.detail.as_deref(),
                        params.source.as_deref().unwrap_or("manual"),
                        params.run_id.as_deref(),
                        params.linked_memory_id.as_deref(),
                        now,
                    )
                }
                "link" => {
                    let id = params.id.clone().ok_or_else(|| {
                        CoreError::invalid("ADMIN_ARGUMENT_INVALID", "backlog link needs an id")
                    })?;
                    store.backlog_link(
                        &id,
                        params.linked_memory_id.as_deref(),
                        params.actor.as_deref(),
                        now,
                    )
                }
                "update" => {
                    let id = params.id.clone().ok_or_else(|| {
                        CoreError::invalid("ADMIN_ARGUMENT_INVALID", "backlog update needs an id")
                    })?;
                    let state = params.state.clone().ok_or_else(|| {
                        CoreError::invalid("ADMIN_ARGUMENT_INVALID", "backlog update needs a state")
                    })?;
                    store.backlog_update(&id, &state, params.actor.as_deref(), now)
                }
                _ => store.backlog_list(
                    params.cursor.as_deref(),
                    params.limit.unwrap_or(lore_core::store::ADMIN_PAGE_DEFAULT),
                    params.state.as_deref(),
                ),
            },
            "ledger" => {
                if params.action.as_deref() == Some("append") {
                    let detail = params.detail.clone().ok_or_else(|| {
                        CoreError::invalid("ADMIN_ARGUMENT_INVALID", "ledger append needs detail")
                    })?;
                    store.ledger_append(
                        params.entry_type.as_deref().unwrap_or("note"),
                        params.subject.as_deref(),
                        &detail,
                        params.actor.as_deref(),
                        now,
                    )
                } else {
                    store.ledger_page(
                        params
                            .cursor
                            .as_deref()
                            .and_then(|value| value.parse().ok()),
                        params.limit.unwrap_or(lore_core::store::ADMIN_PAGE_DEFAULT),
                        params.entry_type.as_deref(),
                    )
                }
            }
            "journal" => match params.action.as_deref().unwrap_or("list") {
                "add" | "update" => store.journal_write(
                    params.id.as_deref(),
                    params.intent.as_deref(),
                    params.state.as_deref().unwrap_or("open"),
                    params.note.as_deref(),
                    now,
                ),
                _ => store.journal_list(
                    params.cursor.as_deref(),
                    params.limit.unwrap_or(lore_core::store::ADMIN_PAGE_DEFAULT),
                    params.state.as_deref(),
                ),
            },
            "review-gate" => {
                if params.action.as_deref() == Some("decide") {
                    let id = params.id.clone().ok_or_else(|| {
                        CoreError::invalid("ADMIN_ARGUMENT_INVALID", "decide needs an id")
                    })?;
                    let state = params
                        .state
                        .clone()
                        .unwrap_or_else(|| "accepted".to_string());
                    store.backlog_update(&id, &state, params.actor.as_deref(), now)
                } else {
                    store.review_gate(now)
                }
            }
            "bundle" => match params.action.as_deref().unwrap_or("export") {
                "import" => {
                    if params.format.as_deref() == Some("json") {
                        return Err(CoreError::invalid(
                            "ADMIN_ARGUMENT_INVALID",
                            "JSON bundle import is not supported",
                        ));
                    }
                    let path = params.path.clone().ok_or_else(|| {
                        CoreError::invalid("ADMIN_ARGUMENT_INVALID", "bundle import needs a path")
                    })?;
                    store.bundle_import_okf(&path, now)
                }
                "export" => store.bundle_export(
                    params.format.as_deref().unwrap_or("json"),
                    params.path.as_deref(),
                    now,
                ),
                other => Err(CoreError::invalid(
                    "ADMIN_ARGUMENT_INVALID",
                    format!("unknown bundle action: {other}"),
                )),
            },
            "skill-validate" => {
                let paths = if params.paths.is_empty() {
                    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
                    lore_core::skills::default_roots(home.as_deref(), Some(&shared.config.data_dir))
                } else {
                    params.paths.clone()
                };
                let validation = lore_core::skills::validate(&paths);
                Ok(lore_core::skills::to_value(&validation))
            }
            "repair" => {
                let source_limit = params
                    .source_limit_bytes
                    .unwrap_or(lore_core::store::REPAIR_SOURCE_LIMIT_BYTES);
                let provider_action = params.action.as_deref().unwrap_or("preview");
                if provider_action == "apply" || params.plan_fingerprint.is_some() {
                    let plan = params.plan_fingerprint.clone().ok_or_else(|| {
                        CoreError::invalid(
                            "ADMIN_ARGUMENT_INVALID",
                            "applying a repair requires planFingerprint",
                        )
                    })?;
                    store.repair_apply(
                        &plan,
                        &params.selected_candidate_ids,
                        source_limit,
                        params.actor.as_deref(),
                        now,
                    )
                } else {
                    store.repair_preview(source_limit)
                }
            }
            "replay" => store.replay_run(params.limit.unwrap_or(50), params.family.as_deref()),
            "doctor" => store.admin_doctor(
                params.dry_run,
                params.limit.unwrap_or(lore_core::store::ADMIN_PAGE_DEFAULT),
            ),
            "audit/extractions" => match (params.action.as_deref(), params.run_id.as_deref()) {
                (Some("apply"), Some(run_id)) => {
                    store.admin_revalidate_extraction(run_id, true, now)
                }
                (Some("rollback"), Some(run_id)) => {
                    store.admin_revalidate_extraction(run_id, false, now)
                }
                (None, _) | (Some("report"), _) => store.admin_audit_extractions(),
                (Some("apply"), None) | (Some("rollback"), None) => Err(CoreError::invalid(
                    "ADMIN_ARGUMENT_INVALID",
                    "apply and rollback need a runId",
                )),
                (Some(other), _) => Err(CoreError::invalid(
                    "ADMIN_ARGUMENT_INVALID",
                    format!("unknown audit action: {other} (report, apply, rollback)"),
                )),
            },
            _ => Err(CoreError::invalid(
                "ADMIN_UNKNOWN",
                "unknown admin operation",
            )),
        }
    })
    .await;
    match result {
        Ok(Ok(value)) => json(
            StatusCode::OK,
            &OkEnvelope {
                ok: true,
                request_id,
                store_id,
                result: value,
            },
        ),
        Ok(Err(error)) => core_response(error, &request_id, &store_id),
        Err(_) => fail_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            code::INTERNAL,
            reason::INTERNAL_FAILURE,
            false,
            Some(&request_id),
            Some(&store_id),
        ),
    }
}

async fn handle_view(
    raw: &[u8],
    state: &Arc<State>,
    fallback_id: Option<String>,
    view: String,
) -> Resp {
    let envelope = match parse_route::<ViewParams>(raw, fallback_id.as_deref(), &state.store_id) {
        Ok(envelope) => envelope,
        Err(response) => return response,
    };
    let request_id = envelope.meta.request_id.clone();
    let store_id = state.store_id.clone();
    if let Some(response) = require_store(&envelope.meta, &store_id, true) {
        return response;
    }
    let params = envelope.params.clone();
    let store = Arc::clone(&state.store);
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, CoreError> {
        match view.as_str() {
            "overview" => store.view_overview(params.repository.as_deref()),
            "health" => store.view_health(),
            "memories" => store.view_memories(
                params.repository.as_deref(),
                params.kind.as_deref(),
                params.scope.as_deref(),
                params.query.as_deref(),
                params.include_forgotten,
                params.cursor.as_deref(),
                params
                    .page_size
                    .or(params.limit)
                    .unwrap_or(lore_core::store::VIEW_PAGE_DEFAULT),
            ),
            "memories/filters" => store.view_filters(),
            "maintenance" => store.view_maintenance(),
            "episodes" => store.view_episodes(),
            "drilldown" => match params.id.as_deref() {
                Some(id) => store.view_drilldown(id),
                None => Err(CoreError::invalid(
                    "VIEW_ARGUMENT_INVALID",
                    "drilldown requires id",
                )),
            },
            _ => Err(CoreError::invalid("VIEW_UNKNOWN", "unknown view")),
        }
    })
    .await;
    match result {
        Ok(Ok(value)) => json(
            StatusCode::OK,
            &OkEnvelope {
                ok: true,
                request_id,
                store_id,
                result: value,
            },
        ),
        Ok(Err(error)) => core_response(error, &request_id, &store_id),
        Err(_) => fail_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            code::INTERNAL,
            reason::INTERNAL_FAILURE,
            false,
            Some(&request_id),
            Some(&store_id),
        ),
    }
}

async fn handle_jobs_status(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    let envelope =
        match parse_route::<JobsStatusParams>(raw, fallback_id.as_deref(), &state.store_id) {
            Ok(envelope) => envelope,
            Err(response) => return response,
        };
    let request_id = envelope.meta.request_id.clone();
    let store_id = state.store_id.clone();
    if let Some(response) = require_store(&envelope.meta, &store_id, true) {
        return response;
    }
    if !state.enabled || unavailable_reason(state).is_some() {
        return disabled_response(
            &envelope.meta,
            &store_id,
            unavailable_reason(state)
                .as_deref()
                .unwrap_or("CONFIG_DISABLED"),
        );
    }
    let _guard = match acquire_client(&envelope.meta.client_id, state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    let limit = envelope.params.limit.unwrap_or(50).clamp(1, 200) as usize;
    let state_filter = envelope.params.state.clone();
    let cursor = envelope.params.cursor.clone();
    let store = Arc::clone(&state.store);
    let identity = state.semantics.identity();
    let now = now_ms();
    let slot = match blocking_slot(state, Some(&request_id)) {
        Ok(slot) => slot,
        Err(response) => return response,
    };
    let work = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let jobs = store.list_jobs(state_filter.as_deref(), cursor.as_deref(), limit)?;
        let counts = match &identity {
            Some(identity) => store.embedding_counts(identity, now)?,
            None => EmbeddingCounts::default(),
        };
        Ok::<_, CoreError>((jobs, counts))
    });
    match tokio::time::timeout(effective_deadline(&envelope.meta, MAX_TIMEOUT_MS), work).await {
        Err(_) => fail_response(
            StatusCode::GATEWAY_TIMEOUT,
            code::DEADLINE_EXCEEDED,
            reason::REQUEST_DEADLINE,
            true,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(Err(_)) => fail_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            code::INTERNAL,
            reason::INTERNAL_FAILURE,
            false,
            Some(&request_id),
            Some(&store_id),
        ),
        Ok(Ok(Err(error))) => core_response(error, &request_id, &store_id),
        Ok(Ok(Ok((jobs, counts)))) => {
            let next_cursor = if jobs.len() == limit {
                jobs.last().map(|job| job.job_id.clone())
            } else {
                None
            };
            json(
                StatusCode::OK,
                &OkEnvelope {
                    ok: true,
                    request_id,
                    store_id,
                    result: JobsStatusResult {
                        jobs: jobs
                            .into_iter()
                            .map(|job| JobRecord {
                                job_id: job.job_id,
                                memory_id: job.memory_id,
                                state: job.state,
                                attempts: job.attempts.max(0) as u64,
                                next_attempt_ms: job.next_attempt_ms,
                                terminal_reason: job.terminal_reason,
                            })
                            .collect(),
                        next_cursor,
                        counts: JobCounts {
                            queued: counts.queued.to_string(),
                            running: counts.running.to_string(),
                            retry_wait: counts.retry_wait.to_string(),
                            failed: counts.failed.to_string(),
                        },
                    },
                },
            )
        }
    }
}

async fn handle_jobs_retry(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    let envelope =
        match parse_route::<JobsRetryParams>(raw, fallback_id.as_deref(), &state.store_id) {
            Ok(envelope) => envelope,
            Err(response) => return response,
        };
    let request_id = envelope.meta.request_id.clone();
    let store_id = state.store_id.clone();
    if let Some(response) = require_store(&envelope.meta, &store_id, true) {
        return response;
    }
    if !state.enabled || unavailable_reason(state).is_some() {
        return disabled_response(
            &envelope.meta,
            &store_id,
            unavailable_reason(state)
                .as_deref()
                .unwrap_or("CONFIG_DISABLED"),
        );
    }
    let _guard = match acquire_client(&envelope.meta.client_id, state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    let client_id = envelope.meta.client_id.clone();
    let key = envelope.params.idempotency_key.clone();
    let hash = policy::sha256_hex(&serde_json::to_vec(&envelope.params).unwrap_or_default());
    match state
        .store
        .lookup_receipt_json(&client_id, "jobs.retry", &key)
    {
        Ok(Some((stored_hash, response))) => {
            if stored_hash != hash {
                return fail_response(
                    StatusCode::CONFLICT,
                    "ALREADY_EXISTS",
                    "IDEMPOTENCY_CONFLICT",
                    false,
                    Some(&request_id),
                    Some(&store_id),
                );
            }
            match serde_json::from_str::<JobsRetryResult>(&response) {
                Ok(result) => {
                    return json(
                        StatusCode::OK,
                        &OkEnvelope {
                            ok: true,
                            request_id,
                            store_id,
                            result,
                        },
                    );
                }
                Err(_) => {
                    return fail_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        code::INTERNAL,
                        reason::INTERNAL_FAILURE,
                        false,
                        Some(&request_id),
                        Some(&store_id),
                    );
                }
            }
        }
        Ok(None) => {}
        Err(error) => return core_response(error, &request_id, &store_id),
    }

    let identity = envelope
        .params
        .provider_id
        .clone()
        .or_else(|| state.semantics.identity());
    let memory_ids = envelope.params.memory_ids.clone();
    let ids = if memory_ids.is_empty() {
        None
    } else {
        Some(memory_ids)
    };
    let store = Arc::clone(&state.store);
    let now = now_ms();
    let slot = match blocking_slot(state, Some(&request_id)) {
        Ok(slot) => slot,
        Err(response) => return response,
    };
    let work = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        store.retry_failed_jobs(identity.as_deref(), ids.as_deref(), now)
    });
    let reset = match tokio::time::timeout(effective_deadline(&envelope.meta, MAX_TIMEOUT_MS), work)
        .await
    {
        Err(_) => {
            return fail_response(
                StatusCode::GATEWAY_TIMEOUT,
                code::DEADLINE_EXCEEDED,
                reason::REQUEST_DEADLINE,
                true,
                Some(&request_id),
                Some(&store_id),
            );
        }
        Ok(Err(_)) => {
            return fail_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                code::INTERNAL,
                reason::INTERNAL_FAILURE,
                false,
                Some(&request_id),
                Some(&store_id),
            );
        }
        Ok(Ok(Err(error))) => return core_response(error, &request_id, &store_id),
        Ok(Ok(Ok(reset))) => reset,
    };
    let result = JobsRetryResult { reset };
    if let Ok(response) = serde_json::to_string(&result) {
        let _ =
            state
                .store
                .store_receipt_json(&client_id, "jobs.retry", &key, &hash, &response, now);
    }
    state.worker_state.request_resume();
    state.notify.notify_one();
    json(
        StatusCode::OK,
        &OkEnvelope {
            ok: true,
            request_id,
            store_id,
            result,
        },
    )
}

async fn handle_config_reload(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    let envelope =
        match parse_route::<ConfigReloadParams>(raw, fallback_id.as_deref(), &state.store_id) {
            Ok(envelope) => envelope,
            Err(response) => return response,
        };
    let request_id = envelope.meta.request_id.clone();
    let store_id = state.store_id.clone();
    if let Some(response) = require_store(&envelope.meta, &store_id, true) {
        return response;
    }
    let _guard = match acquire_client(&envelope.meta.client_id, state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    let Some(config_path) = state.config_path.clone() else {
        return fail_response(
            StatusCode::PRECONDITION_FAILED,
            code::FAILED_PRECONDITION,
            "CONFIG_RELOAD_REJECTED",
            false,
            Some(&request_id),
            Some(&store_id),
        );
    };
    let fresh = match ResolvedConfig::load(Some(&config_path), None, None) {
        Ok(config) => config,
        Err(error) => return core_response(error, &request_id, &store_id),
    };
    if fresh.data_dir != state.config.data_dir || fresh.socket_path != state.config.socket_path {
        return fail_response(
            StatusCode::PRECONDITION_FAILED,
            code::FAILED_PRECONDITION,
            "CONFIG_RELOAD_REJECTED",
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }
    let next_identity = fresh.embedding_identity.clone();
    if next_identity == state.semantics.identity() {
        return json(
            StatusCode::OK,
            &OkEnvelope {
                ok: true,
                request_id,
                store_id,
                result: ConfigReloadResult {
                    reloaded: false,
                    generation: state.generation.load(Ordering::Relaxed),
                    reason: "UNCHANGED".to_string(),
                },
            },
        );
    }
    let provider = match &fresh.embedding {
        Some(embedding) => match build_provider(embedding) {
            Ok(provider) => Some(Arc::new(provider)),
            Err(error) => return core_response(error, &request_id, &store_id),
        },
        None => None,
    };
    let min_similarity = fresh
        .embedding
        .as_ref()
        .map(|embedding| embedding.min_similarity)
        .unwrap_or(0.0);
    let generation = fresh
        .embedding
        .as_ref()
        .map(|embedding| embedding.generation)
        .unwrap_or(0);
    state
        .semantics
        .replace(provider, next_identity, min_similarity);
    state.generation.store(generation, Ordering::Relaxed);
    state.worker_state.request_resume();
    state.notify.notify_one();
    json(
        StatusCode::OK,
        &OkEnvelope {
            ok: true,
            request_id,
            store_id,
            result: ConfigReloadResult {
                reloaded: true,
                generation,
                reason: "PROVIDER_GENERATION_CHANGED".to_string(),
            },
        },
    )
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

fn fail_response(
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

/// Optional augmentation lane. Bounded, in-memory only, and never mutating:
/// the daemon refetches every client-selected record and trusts only ids and
/// revisions it can revalidate.
async fn handle_analysis(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    use protocol::AnalysisParams;

    let envelope = match parse_route::<AnalysisParams>(raw, fallback_id.as_deref(), &state.store_id)
    {
        Ok(envelope) => envelope,
        Err(response) => return response,
    };
    let request_id = envelope.meta.request_id.clone();
    if let Some(response) = require_store(&envelope.meta, &state.store_id, true) {
        return response;
    }
    let Some(config) = state.analysis.as_ref() else {
        return fail_response(
            StatusCode::NOT_IMPLEMENTED,
            code::UNIMPLEMENTED,
            "ANALYSIS_UNAVAILABLE",
            false,
            Some(&request_id),
            Some(&state.store_id),
        );
    };
    let params = envelope.params;
    let kind = params.kind.as_str();
    if kind != "query-expansion" && kind != "context-compression" {
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            "ANALYSIS_KIND_INVALID",
            false,
            Some(&request_id),
            Some(&state.store_id),
        );
    }
    const MAX_QUERY: usize = 16 * 1024;
    let query = params.query.clone().unwrap_or_default();
    if query.is_empty() || query.len() > MAX_QUERY {
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            "ANALYSIS_QUERY_INVALID",
            false,
            Some(&request_id),
            Some(&state.store_id),
        );
    }
    if kind == "context-compression" && params.records.is_empty() {
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            "ANALYSIS_RECORDS_REQUIRED",
            false,
            Some(&request_id),
            Some(&state.store_id),
        );
    }

    // Refetch and revalidate the client's selection before any model work.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);
    let selection: Vec<(String, i64)> = params
        .records
        .iter()
        .map(|record| (record.id.clone(), record.revision))
        .collect();
    let records = if kind == "context-compression" {
        let store = Arc::clone(&state.store);
        let repository = params.repository.clone();
        match tokio::task::spawn_blocking(move || {
            store.analysis_records(repository.as_deref(), &selection, now)
        })
        .await
        {
            Ok(Ok(records)) => records,
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    };

    // Nothing survived revalidation: no model work and no empty prompt.
    if kind == "context-compression" && records.is_empty() {
        return json(
            StatusCode::OK,
            &OkEnvelope {
                ok: true,
                request_id,
                store_id: state.store_id.clone(),
                result: serde_json::json!({
                    "kind": kind,
                    "terms": Value::Null,
                    "sections": [],
                    "diagnostics": {
                        "deadlineMs": config.default_deadline_ms,
                        "model": config.model,
                        "recordsRequested": params.records.len(),
                        "recordsUsed": 0,
                        "recordsDropped": params.records.len(),
                        "provider": "skipped",
                    },
                }),
            },
        );
    }
    let prompt = build_analysis_prompt(kind, &query, params.repository.as_deref(), &records);
    let provider = match lore_provider::ChatProvider::new(
        &config.endpoint,
        &config.model,
        config.api_key.clone(),
        std::time::Duration::from_millis(config.max_deadline_ms),
    ) {
        Ok(provider) => provider,
        Err(_) => {
            return fail_response(
                StatusCode::BAD_GATEWAY,
                code::INTERNAL,
                "ANALYSIS_CONFIG",
                false,
                Some(&request_id),
                Some(&state.store_id),
            );
        }
    };
    // One optional chat lane: a second concurrent request is refused instead
    // of queueing behind model work.
    let _lane = match Arc::clone(&state.chat_lane).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return fail_response(
                StatusCode::CONFLICT,
                code::FAILED_PRECONDITION,
                "ANALYSIS_BUSY",
                true,
                Some(&request_id),
                Some(&state.store_id),
            );
        }
    };
    let deadline_ms = params
        .deadline_ms
        .unwrap_or(config.default_deadline_ms)
        .clamp(1_000, config.max_deadline_ms);
    let completion = tokio::time::timeout(
        std::time::Duration::from_millis(deadline_ms + 250),
        provider.complete(&prompt),
    )
    .await;
    let text = match completion {
        Ok(Ok(text)) => text,
        Ok(Err(error)) => {
            let (reason, retryable) = match error {
                lore_provider::ProviderError::Transient(message)
                    if message.contains("timed out") =>
                {
                    ("ANALYSIS_TIMEOUT", true)
                }
                lore_provider::ProviderError::Transient(_) => ("ANALYSIS_UNAVAILABLE", true),
                lore_provider::ProviderError::Auth(_) => ("ANALYSIS_UNAUTHORIZED", false),
                lore_provider::ProviderError::ModelInvalid(_)
                | lore_provider::ProviderError::Config(_) => ("ANALYSIS_CONFIG", false),
                _ => ("ANALYSIS_INVALID_RESPONSE", false),
            };
            return fail_response(
                StatusCode::BAD_GATEWAY,
                code::INTERNAL,
                reason,
                retryable,
                Some(&request_id),
                Some(&state.store_id),
            );
        }
        Err(_) => {
            return fail_response(
                StatusCode::GATEWAY_TIMEOUT,
                code::INTERNAL,
                "ANALYSIS_TIMEOUT",
                true,
                Some(&request_id),
                Some(&state.store_id),
            );
        }
    };

    let parsed: Value = match parse_analysis_completion(kind, &text, &records) {
        Ok(parsed) => parsed,
        Err(_) => {
            return fail_response(
                StatusCode::BAD_GATEWAY,
                code::INTERNAL,
                "ANALYSIS_INVALID_RESPONSE",
                false,
                Some(&request_id),
                Some(&state.store_id),
            );
        }
    };
    let result = serde_json::json!({
        "kind": kind,
        "terms": parsed.get("terms").cloned().unwrap_or(Value::Null),
        "sections": parsed.get("sections").cloned().unwrap_or(Value::Null),
        "diagnostics": {
            "deadlineMs": deadline_ms,
            "model": config.model,
            "recordsRequested": params.records.len(),
            "recordsUsed": records.len(),
            "recordsDropped": params.records.len().saturating_sub(records.len()),
            "provider": if provider.is_loopback() { "loopback" } else { "remote" },
        },
    });
    json(
        StatusCode::OK,
        &OkEnvelope {
            ok: true,
            request_id,
            store_id: state.store_id.clone(),
            result,
        },
    )
}

fn build_analysis_prompt(
    kind: &str,
    query: &str,
    repository: Option<&str>,
    records: &[Value],
) -> String {
    let mut prompt = String::new();
    if kind == "query-expansion" {
        prompt.push_str(
            "Expand the following search query into at most 24 short alternative terms. ",
        );
        prompt.push_str("Reply with JSON: {\"terms\": [\"...\"]}. Do not add commentary.\n");
    } else {
        prompt.push_str("Compress the following records into at most 12 short sections. ");
        prompt.push_str(
            "Reply with JSON: {\"sections\": [{\"id\": \"<record id>\", \"text\": \"...\"}]}. ",
        );
        prompt.push_str("Use only the supplied ids and never invent one. Do not add commentary.\n");
        for record in records {
            let content = record["content"].as_str().unwrap_or_default();
            let bounded: String = content.chars().take(2_000).collect();
            prompt.push_str(&format!(
                "\n[{}] {bounded}\n",
                record["id"].as_str().unwrap_or_default()
            ));
        }
    }
    prompt.push_str("\nRepository: ");
    prompt.push_str(repository.unwrap_or("global"));
    prompt.push_str("\nQuery: ");
    prompt.push_str(query);
    prompt.truncate(64 * 1024);
    prompt
}

/// Validate the model's JSON against the bounded contract. Unknown ids are
/// rejected rather than trusted.
fn parse_analysis_completion(kind: &str, text: &str, records: &[Value]) -> Result<Value, String> {
    let trimmed = text.trim();
    let json_text = trimmed
        .strip_prefix("```json")
        .and_then(|rest| rest.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);
    let parsed: Value = serde_json::from_str(json_text).map_err(|error| error.to_string())?;
    if kind == "query-expansion" {
        let terms = parsed["terms"].as_array().ok_or("terms missing")?;
        if terms.len() > 32 {
            return Err("too many terms".to_string());
        }
        let bounded: Vec<Value> = terms
            .iter()
            .filter_map(|term| term.as_str())
            .filter(|term| !term.is_empty() && term.chars().count() <= 64)
            .take(32)
            .map(|term| Value::String(term.to_string()))
            .collect();
        Ok(serde_json::json!({ "terms": bounded }))
    } else {
        let sections = parsed["sections"].as_array().ok_or("sections missing")?;
        if sections.len() > 50 {
            return Err("too many sections".to_string());
        }
        let known: std::collections::HashSet<&str> = records
            .iter()
            .filter_map(|record| record["id"].as_str())
            .collect();
        let mut bounded = Vec::new();
        for section in sections {
            let Some(id) = section["id"].as_str() else {
                continue;
            };
            if !known.contains(id) {
                return Err(format!("unknown record id in sections: {id}"));
            }
            let text = section["text"].as_str().unwrap_or_default();
            let bounded_text: String = text.chars().take(2_048).collect();
            bounded.push(serde_json::json!({ "id": id, "text": bounded_text }));
        }
        Ok(serde_json::json!({ "sections": bounded }))
    }
}

/// One bounded chat synthesis for reflection. Evidence checks reject output
/// that names ids outside the represented set; every other failure maps to a
/// fallback reason rather than an error, so the deterministic digest is
/// always available.
async fn analysis_synthesis(
    state: &Arc<State>,
    query: &str,
    digest: &str,
    represented: &[String],
) -> Result<String, String> {
    let Some(config) = state.analysis.as_ref() else {
        return Err("ANALYSIS_UNAVAILABLE".to_string());
    };
    let provider = lore_provider::ChatProvider::new(
        &config.endpoint,
        &config.model,
        config.api_key.clone(),
        std::time::Duration::from_millis(config.default_deadline_ms),
    )
    .map_err(|_| "ANALYSIS_CONFIG".to_string())?;
    let _lane = Arc::clone(&state.chat_lane)
        .try_acquire_owned()
        .map_err(|_| "ANALYSIS_BUSY".to_string())?;
    let mut prompt = String::from(
        "Rewrite the following digest as a short synthesis (at most 800 characters). \
         Reference only these memory ids when you need one: ",
    );
    prompt.push_str(&represented.join(", "));
    prompt.push_str(". Never invent an id. Reply with plain text only.\n\nDigest:\n");
    prompt.push_str(&digest.chars().take(8_000).collect::<String>());
    if !query.is_empty() {
        prompt.push_str("\nQuery: ");
        prompt.push_str(query);
    }
    let deadline = config.default_deadline_ms;
    let completion = tokio::time::timeout(
        std::time::Duration::from_millis(deadline + 250),
        provider.complete(&prompt),
    )
    .await;
    let text = match completion {
        Ok(Ok(text)) => text,
        Ok(Err(lore_provider::ProviderError::Transient(message)))
            if message.contains("timed out") =>
        {
            return Err("ANALYSIS_TIMEOUT".to_string());
        }
        Ok(Err(_)) => return Err("ANALYSIS_UNAVAILABLE".to_string()),
        Err(_) => return Err("ANALYSIS_TIMEOUT".to_string()),
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("EVIDENCE_CHECK_FAILED".to_string());
    }
    if text.chars().count() > 4_096 {
        return Err("EVIDENCE_CHECK_FAILED".to_string());
    }
    let known: std::collections::HashSet<&str> = represented.iter().map(String::as_str).collect();
    let mut token = String::new();
    for character in text.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            token.push(character);
            continue;
        }
        if !token.is_empty() {
            if (token.starts_with("mem_") || token.matches('-').count() == 4)
                && !known.contains(token.as_str())
            {
                return Err("EVIDENCE_CHECK_FAILED".to_string());
            }
            token.clear();
        }
    }
    Ok(text)
}

/// Optional fail-open rerank of the topical recall section. Any provider
/// failure, invalid output or structural surprise leaves the fused order
/// untouched and records why.
async fn apply_rerank(state: &Arc<State>, query: &str, mut value: Value) -> Value {
    let Some(config) = (*state.analysis)
        .as_ref()
        .filter(|analysis| analysis.rerank)
    else {
        return value;
    };
    let topical_index = value["sections"].as_array().and_then(|sections| {
        sections
            .iter()
            .position(|section| section["id"] == "topical")
    });
    let Some(topical_index) = topical_index else {
        value["diagnostics"]["rerank"] =
            serde_json::json!({ "applied": false, "reason": "NO_TOPICAL_SECTION" });
        return value;
    };
    let topical_ids: Vec<String> = value["sections"][topical_index]["memoryIds"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|id| id.as_str().map(str::to_string))
        .collect();
    if topical_ids.len() < 2 {
        value["diagnostics"]["rerank"] =
            serde_json::json!({ "applied": false, "reason": "TOO_FEW_CANDIDATES" });
        return value;
    }
    let original_text = value["sections"][topical_index]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let context = value["context"].as_str().unwrap_or_default().to_string();
    if !context.ends_with(&original_text) {
        value["diagnostics"]["rerank"] =
            serde_json::json!({ "applied": false, "reason": "CONTEXT_SHAPE" });
        return value;
    }

    let mut candidates: Vec<(String, String)> = Vec::new();
    for id in topical_ids.iter().take(20) {
        let content = value["records"]
            .as_array()
            .and_then(|records| records.iter().find(|record| record["id"] == id.as_str()))
            .and_then(|record| record["content"].as_str())
            .map(|content| content.chars().take(400).collect::<String>());
        if let Some(content) = content {
            candidates.push((id.clone(), content));
        }
    }
    if candidates.len() < 2 {
        value["diagnostics"]["rerank"] =
            serde_json::json!({ "applied": false, "reason": "TOO_FEW_CANDIDATES" });
        return value;
    }

    let provider = match lore_provider::ChatProvider::new(
        &config.endpoint,
        &config.model,
        config.api_key.clone(),
        std::time::Duration::from_millis(config.default_deadline_ms),
    ) {
        Ok(provider) => provider,
        Err(_) => {
            value["diagnostics"]["rerank"] =
                serde_json::json!({ "applied": false, "reason": "ANALYSIS_CONFIG" });
            return value;
        }
    };
    let _lane = match Arc::clone(&state.chat_lane).try_acquire_owned() {
        Ok(lane) => lane,
        Err(_) => {
            value["diagnostics"]["rerank"] =
                serde_json::json!({ "applied": false, "reason": "ANALYSIS_BUSY" });
            return value;
        }
    };
    let mut prompt = String::from(
        "Order these memory candidates by relevance to the query, most relevant first. \
         Reply with JSON: {\"order\": [\"<id>\", ...]} using only the supplied ids.\n",
    );
    for (id, content) in &candidates {
        prompt.push_str(&format!("\n[{id}] {content}"));
    }
    prompt.push_str("\n\nQuery: ");
    prompt.push_str(query);
    let completion = tokio::time::timeout(
        std::time::Duration::from_millis(config.default_deadline_ms + 250),
        provider.complete(&prompt),
    )
    .await;
    let text = match completion {
        Ok(Ok(text)) => text,
        _ => {
            value["diagnostics"]["rerank"] =
                serde_json::json!({ "applied": false, "reason": "ANALYSIS_UNAVAILABLE" });
            return value;
        }
    };
    let trimmed = text.trim();
    let json_text = trimmed
        .strip_prefix("```json")
        .and_then(|rest| rest.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);
    let parsed: Value = match serde_json::from_str(json_text) {
        Ok(parsed) => parsed,
        Err(_) => {
            value["diagnostics"]["rerank"] =
                serde_json::json!({ "applied": false, "reason": "ANALYSIS_INVALID_RESPONSE" });
            return value;
        }
    };
    let known: std::collections::HashSet<&str> =
        candidates.iter().map(|(id, _)| id.as_str()).collect();
    let mut order: Vec<String> = Vec::new();
    for id in parsed["order"].as_array().cloned().unwrap_or_default() {
        let Some(id) = id.as_str() else {
            continue;
        };
        if !known.contains(id) {
            value["diagnostics"]["rerank"] =
                serde_json::json!({ "applied": false, "reason": "EVIDENCE_CHECK_FAILED" });
            return value;
        }
        if !order.iter().any(|existing| existing == id) {
            order.push(id.to_string());
        }
    }
    for (id, _) in &candidates {
        if !order.iter().any(|existing| existing == id) {
            order.push(id.clone());
        }
    }
    let contents: Vec<String> = order
        .iter()
        .filter_map(|id| {
            candidates
                .iter()
                .find(|(candidate, _)| candidate == id)
                .map(|(_, content)| content.clone())
        })
        .collect();
    let budget = original_text.len().max(1);
    let (text, included, omitted) = lore_core::retrieval::render_topical(&contents, budget);
    let prefix = &context[..context.len() - original_text.len()];
    value["context"] = Value::String(format!("{prefix}{text}"));
    if let Some(section) = value["sections"]
        .as_array_mut()
        .and_then(|sections| sections.get_mut(topical_index))
    {
        section["text"] = Value::String(text);
        section["memoryIds"] = serde_json::json!(order[..included.min(order.len())]);
        section["omitted"] = serde_json::json!(omitted);
    }
    if let Some(records) = value["records"].as_array_mut() {
        let mandatory: Vec<Value> = records
            .iter()
            .filter(|record| {
                record["id"]
                    .as_str()
                    .is_some_and(|id| !topical_ids.iter().any(|topical| topical == id))
            })
            .cloned()
            .collect();
        let mut reordered = mandatory;
        for id in &order {
            if let Some(record) = records
                .iter()
                .find(|record| record["id"].as_str() == Some(id.as_str()))
            {
                reordered.push(record.clone());
            }
        }
        *records = reordered;
    }
    value["diagnostics"]["rerank"] = serde_json::json!({
        "applied": true,
        "provider": if provider.is_loopback() { "loopback" } else { "remote" },
        "candidates": candidates.len(),
    });
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::body::Body;

    #[tokio::test]
    async fn deadline_rejects_slow_work() {
        let work = tokio::time::timeout(Duration::from_millis(10), async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            "late"
        })
        .await;
        assert!(work.is_err());
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
