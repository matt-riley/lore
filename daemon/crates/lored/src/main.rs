//! `lored` — the Lore v2 daemon.
//!
//! Stage 2: durable Status, Retain, Forget and lexical Recall over a Unix
//! socket, with store/endpoint ownership, bounded foreground admission and
//! crash-safe acknowledgements.

use std::collections::HashMap;
use std::convert::Infallible;
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
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;
use uuid::Uuid;

use lore_core::config::{ResolvedConfig, ResolvedEmbedding};
use lore_core::error::CoreError;
use lore_core::lifecycle;
use lore_core::policy;
use lore_core::store::{EmbeddingCounts, SemanticInput, Store};
use lore_provider::{EmbeddingProvider, ProviderIdentity};
use tokio::sync::Notify;

use semantics::{QueryOutcome, Semantics};
use worker::{WorkerState, spawn as spawn_worker};

mod semantics;
mod worker;
use protocol::{
    API_MAJOR, API_MINOR, BODY_DEADLINE_MS, ConfigReloadParams, ConfigReloadResult,
    EmbeddingStatus, Envelope, ErrorDetail, ErrorEnvelope, ForgetParams, HOST, JobCounts,
    JobRecord, JobsRetryParams, JobsRetryResult, JobsStatusParams, JobsStatusResult,
    MAX_BODY_BYTES, MAX_TIMEOUT_MS, OkEnvelope, Readiness, RecallParams, RequestMeta, RetainParams,
    StatusCounts, StatusParams, StatusQueue, StatusResult, code, reason,
};

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
    #[arg(long, env = "LORE_V2_SOCKET")]
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
    max_inflight: usize,
    clients: Mutex<HashMap<String, usize>>,
    semantics: Arc<Semantics>,
    worker_state: Arc<WorkerState>,
    notify: Arc<Notify>,
    generation: AtomicU32,
    config_path: Option<PathBuf>,
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
    let state = Arc::new(State {
        store,
        store_id: initial.store_id,
        enabled: config.enabled,
        config: config.clone(),
        process_instance_id: Uuid::new_v4().to_string(),
        started: Instant::now(),
        inflight: Arc::new(Semaphore::new(max_inflight)),
        max_inflight,
        clients: Mutex::new(HashMap::new()),
        semantics,
        worker_state,
        notify,
        generation: AtomicU32::new(generation),
        config_path: config.config_path.clone(),
    });
    eprintln!(
        "[lored] listening on {} (store {})",
        config.socket_path.display(),
        state.store_id
    );

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
    if let Err(error) = http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .await
    {
        eprintln!("[lored] connection error: {error}");
    }
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
    if !matches!(
        path.as_str(),
        "/v2/status"
            | "/v2/retain"
            | "/v2/forget"
            | "/v2/recall"
            | "/v2/jobs/status"
            | "/v2/jobs/retry"
            | "/v2/config/reload"
    ) {
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
        "/v2/status" => handle_status(&raw, &state, request_id).await,
        "/v2/retain" => handle_retain(&raw, &state, request_id).await,
        "/v2/forget" => handle_forget(&raw, &state, request_id).await,
        "/v2/jobs/status" => handle_jobs_status(&raw, &state, request_id).await,
        "/v2/jobs/retry" => handle_jobs_retry(&raw, &state, request_id).await,
        "/v2/config/reload" => handle_config_reload(&raw, &state, request_id).await,
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

fn disabled_response(meta: &RequestMeta, store_id: &str) -> Resp {
    fail_response(
        StatusCode::PRECONDITION_FAILED,
        code::FAILED_PRECONDITION,
        "CONFIG_DISABLED",
        false,
        Some(&meta.request_id),
        Some(store_id),
    )
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

    let store = Arc::clone(&state.store);
    let identity = state.semantics.identity();
    let now = now_ms();
    let work = tokio::task::spawn_blocking(move || {
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
            if !state.enabled {
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
                        schema_version: 2,
                        store_id: state.store_id.clone(),
                        process_instance_id: state.process_instance_id.clone(),
                        uptime_ms: state.started.elapsed().as_millis() as u64,
                        readiness: if state.enabled {
                            Readiness::Ready
                        } else {
                            Readiness::Unavailable
                        },
                        reason: if state.enabled {
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
    if !state.enabled {
        return disabled_response(&envelope.meta, &store_id);
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
    let work = tokio::task::spawn_blocking(move || store.retain(&client_id, &params, now));
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
    if !state.enabled {
        return disabled_response(&envelope.meta, &store_id);
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
    let work = tokio::task::spawn_blocking(move || store.forget(&client_id, &params, now));
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
    if !state.enabled {
        return disabled_response(&envelope.meta, &store_id);
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
    let work = tokio::task::spawn_blocking(move || {
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
    if !state.enabled {
        return disabled_response(&envelope.meta, &store_id);
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
    let work = tokio::task::spawn_blocking(move || {
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
    if !state.enabled {
        return disabled_response(&envelope.meta, &store_id);
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
    let work = tokio::task::spawn_blocking(move || {
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
