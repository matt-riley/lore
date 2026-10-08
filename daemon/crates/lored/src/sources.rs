//! Source registration, hints, status and the background capture sweep.

use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::time::Duration;

use hyper::StatusCode;
use protocol::{
    ExtractionRetryParams, ExtractionRetryResult, OkEnvelope, SourceHintParams, SourceHintResult,
    SourceRegisterParams, SourceRegisterResult, SourceStatusCounts, SourceStatusParams,
    SourceStatusRecord, SourceStatusResult, code, reason,
};

use lore_core::config::ResolvedConfig;
use lore_core::error::CoreError;
use lore_core::extraction::{RULE_VERSION, TurnInput, extract};
use lore_core::ingestion::{
    CAPTURE_PER_ROOT, PENDING_PER_SWEEP, SweepReport, capture_source, discover_page,
    register_hinted_source, root_for,
};
use lore_core::store::{SourceFilter, SourceRow, Store};

use super::{
    Resp, State, core_response, disabled_response, fail_response, json, now_ms, parse_route,
    require_store, unavailable_reason,
};

/// Wake channel and join handle for the capture scheduler thread.
pub struct Scheduler {
    sender: Sender<()>,
}

impl Scheduler {
    /// Request an immediate sweep after a hint or registration.
    pub fn wake(&self) {
        let _ = self.sender.send(());
    }
}

/// Serializes sweeps across the scheduler thread and admin backfill, so two
/// concurrent sweeps cannot discover and register the same file twice.
static SWEEP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Spawn the capture scheduler. Sweeps run on a dedicated thread so capture
/// never contends with the async request runtime.
pub fn spawn(store: Arc<Store>, config: ResolvedConfig) -> Scheduler {
    let (sender, receiver) = channel::<()>();
    let sweep = Duration::from_secs(config.sources.sweep_seconds);
    std::thread::Builder::new()
        .name("lore-sources".into())
        .spawn(move || {
            while let Ok(()) | Err(RecvTimeoutError::Timeout) = receiver.recv_timeout(sweep) {
                let report = run_sweep(&store, &config, now_ms());
                if report.discovered > 0 || report.captured > 0 || report.pending > 0 {
                    eprintln!(
                        "[lored] sources sweep: roots={} discovered={} captured={} pending={} unavailable={}",
                        report.roots,
                        report.discovered,
                        report.captured,
                        report.pending,
                        report.unavailable
                    );
                }
            }
        })
        .expect("spawn source scheduler");
    Scheduler { sender }
}

/// One extraction sweep outcome.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionSweepReport {
    pub claimed: usize,
    pub applied: usize,
    pub retired: usize,
    pub suppressed: usize,
    pub unresolved: usize,
    pub failed: usize,
    pub episodes: usize,
    pub day_summaries: usize,
}

/// Run extraction for pending intents: claim with a lease, compute outside
/// the writer, apply atomically, then complete or release the claim.
pub fn extract_pending(store: &Store, limit: usize, now: i64) -> ExtractionSweepReport {
    let mut report = ExtractionSweepReport::default();
    for _ in 0..limit {
        let claim = match store.claim_extraction_intent("lored", RULE_VERSION, 120_000, now) {
            Ok(Some(claim)) => claim,
            Ok(None) => break,
            Err(_) => break,
        };
        report.claimed += 1;
        let row = match store.source_by_id(&claim.source_id) {
            Ok(Some(row)) => row,
            Ok(None) => {
                let _ = store.fail_extraction(&claim, "SOURCE_UNKNOWN", now);
                report.failed += 1;
                continue;
            }
            Err(_) => {
                let _ = store.fail_extraction(&claim, "SOURCE_UNREADABLE", now);
                report.failed += 1;
                continue;
            }
        };
        let records = match store.source_records(&claim.source_id, &claim.generation, 100_000) {
            Ok(records) => records,
            Err(_) => {
                let _ = store.fail_extraction(&claim, "SOURCE_UNREADABLE", now);
                report.failed += 1;
                continue;
            }
        };
        let turns: Vec<TurnInput> = records
            .iter()
            .map(|record| TurnInput {
                role: record.role.clone().unwrap_or_else(|| record.kind.clone()),
                text: record.text.clone(),
                evidence_key: record.evidence_key.clone(),
                turn_index: record.turn_index.unwrap_or(0),
                completeness: record.completeness.clone(),
            })
            .collect();
        // Only a verified repository may scope automatic guidance; an
        // unresolved identity stays unresolved and is never promoted global.
        let repository = row
            .repository_verified
            .then(|| row.repository.clone())
            .flatten();
        let extraction = extract(repository.as_deref(), &turns);
        match store.apply_proposals(
            &claim.source_id,
            &claim.generation,
            &extraction.proposals,
            now,
        ) {
            Ok(applied) => {
                report.applied += applied.applied;
                report.retired += applied.retired;
                report.suppressed += applied.suppressed;
                report.unresolved += applied.unresolved;
                if store
                    .complete_extraction(&claim, applied.applied, now)
                    .unwrap_or(false)
                {
                    let _ = store.store_extraction_receipt(
                        &claim.source_id,
                        &claim.generation,
                        &claim.rule_version,
                        &serde_json::to_string(&applied).unwrap_or_default(),
                        now,
                    );
                }
            }
            Err(_) => {
                let _ = store.fail_extraction(&claim, "APPLY_FAILED", now);
                report.failed += 1;
            }
        }
    }
    // Episode digests and day summaries follow the extraction they summarize.
    if let Ok(digests) = store.build_digests(8, now) {
        report.episodes = digests.episodes;
        report.day_summaries = digests.day_summaries;
    }
    report
}

/// Discover and capture for all approved roots, bounded per sweep.
pub fn run_sweep(store: &Store, config: &ResolvedConfig, now: i64) -> SweepReport {
    let _guard = SWEEP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    run_sweep_locked(store, config, now)
}

fn run_sweep_locked(store: &Store, config: &ResolvedConfig, now: i64) -> SweepReport {
    let sources = &config.sources;
    let mut report = SweepReport::default();
    let keep: Vec<String> = sources
        .roots
        .iter()
        .map(|root| root.root_id.clone())
        .collect();
    for root in &sources.roots {
        if let Err(error) = lore_core::ingestion::reject_relative_escape(&root.path) {
            eprintln!(
                "[lored] source root {} rejected: {}",
                root.root_id, error.message
            );
            continue;
        }
        if let Err(error) = store.upsert_source_root(
            &root.root_id,
            &root.client,
            &root.path.to_string_lossy(),
            root.repository.as_deref(),
            now,
        ) {
            eprintln!(
                "[lored] source root {} unavailable: {}",
                root.root_id, error.message
            );
        }
    }
    let _ = store.prune_source_roots(&keep);

    // Finish sources already known to be behind before discovering new ones.
    if let Ok(pending) = store.source_queue(PENDING_PER_SWEEP) {
        for row in pending {
            report.pending += 1;
            let capture = capture_source(store, sources, &row, now);
            if capture.records > 0 || capture.conflict {
                report.captured += 1;
            }
            if capture.state == "unavailable" || capture.state == "ambiguous" {
                report.unavailable += 1;
            }
        }
    }

    for root in &sources.roots {
        let cursor = match store.source_roots() {
            Ok(roots) => roots
                .into_iter()
                .find(|row| row.root_id == root.root_id)
                .and_then(|row| row.cursor),
            Err(_) => None,
        };
        let (registered, next_cursor, complete) =
            match discover_page(store, root, cursor.as_deref(), sources.page_entries, now) {
                Ok(value) => value,
                Err(error) => {
                    if error.code == "SOURCE_ROOT_UNAVAILABLE" {
                        report.unavailable += 1;
                    }
                    continue;
                }
            };
        report.roots += 1;
        report.discovered += registered.len();
        for row in registered.iter().take(CAPTURE_PER_ROOT) {
            let capture = capture_source(store, sources, row, now);
            report.captured += 1;
            if capture.state == "unavailable" || capture.state == "ambiguous" {
                report.unavailable += 1;
            }
        }
        let _ = store.set_source_root_cursor(&root.root_id, next_cursor.as_deref(), complete, now);
    }

    // Extraction runs after capture so fresh evidence is processed in the
    // same sweep that committed it.
    let extraction = extract_pending(store, PENDING_PER_SWEEP, now);
    if extraction.claimed > 0 {
        eprintln!(
            "[lored] extraction sweep: claimed={} applied={} retired={} suppressed={} unresolved={} failed={}",
            extraction.claimed,
            extraction.applied,
            extraction.retired,
            extraction.suppressed,
            extraction.unresolved,
            extraction.failed
        );
    }
    report
}

/// Resolve an absolute hinted path against approved roots without expanding
/// the approved set.
pub fn resolve_hinted_path(
    config: &ResolvedConfig,
    client: &str,
    root_id: &str,
    path: &str,
) -> Result<std::path::PathBuf, CoreError> {
    root_for(&config.sources, root_id, client)?;
    if !Path::new(path).is_absolute() {
        return Err(CoreError::invalid(
            "SOURCE_PATH_INVALID",
            "source path must be absolute",
        ));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| CoreError::precondition("SOURCE_UNAVAILABLE", format!("{error}")))?;
    Ok(canonical)
}

pub async fn handle_register(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    let envelope =
        match parse_route::<SourceRegisterParams>(raw, fallback_id.as_deref(), &state.store_id) {
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
    let client_id = envelope.meta.client_id.clone();
    let key = envelope.params.idempotency_key.clone();
    let hash =
        lore_core::policy::sha256_hex(&serde_json::to_vec(&envelope.params).unwrap_or_default());
    match state
        .store
        .lookup_receipt_json(&client_id, "sources.register", &key)
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
            return match serde_json::from_str::<SourceRegisterResult>(&response) {
                Ok(result) => json(
                    StatusCode::OK,
                    &OkEnvelope {
                        ok: true,
                        request_id,
                        store_id,
                        result,
                    },
                ),
                Err(_) => fail_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    code::INTERNAL,
                    reason::INTERNAL_FAILURE,
                    false,
                    Some(&request_id),
                    Some(&store_id),
                ),
            };
        }
        Ok(None) => {}
        Err(error) => return core_response(error, &request_id, &store_id),
    }

    let config = state.config.clone();
    let store = Arc::clone(&state.store);
    let params = envelope.params.clone();
    let now = now_ms();
    let outcome =
        tokio::task::spawn_blocking(move || -> Result<(&'static str, SourceRow), CoreError> {
            let root = root_for(&config.sources, &params.root_id, &params.client)?;
            let canonical = match params.path.as_deref() {
                Some(path) => Some(resolve_hinted_path(
                    &config,
                    &params.client,
                    &params.root_id,
                    path,
                )?),
                None => None,
            };
            match canonical {
                Some(path) => register_hinted_source(
                    &store,
                    root,
                    &path,
                    params.native_session_id.as_deref(),
                    params.repository.as_deref(),
                    now,
                )
                .map(|row| ("eligible", row)),
                None => {
                    let Some(native) = params.native_session_id.as_deref() else {
                        return Err(CoreError::invalid(
                            "SOURCE_ARGUMENT_INVALID",
                            "path or nativeSessionId is required",
                        ));
                    };
                    let _ = native;
                    Err(CoreError::invalid(
                        "SOURCE_ARGUMENT_INVALID",
                        "path is required for source registration",
                    ))
                }
            }
        })
        .await;
    let (_, row) = match outcome {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return core_response(error, &request_id, &store_id),
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
    };
    let result = SourceRegisterResult {
        source_id: row.source_id.clone(),
        state: "queued".into(),
        accepted: true,
        coalesced: false,
        generation: row.generation.clone(),
    };
    if let Ok(response) = serde_json::to_string(&result) {
        let _ = state.store.store_receipt_json(
            &client_id,
            "sources.register",
            &key,
            &hash,
            &response,
            now,
        );
    }
    let _ =
        state
            .store
            .mark_source_state(&row.source_id, "queued", None, None, row.pending_bytes, now);
    state.scheduler.wake();
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

pub async fn handle_hint(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    let envelope =
        match parse_route::<SourceHintParams>(raw, fallback_id.as_deref(), &state.store_id) {
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
    let client_id = envelope.meta.client_id.clone();
    let key = envelope.params.idempotency_key.clone();
    let hash =
        lore_core::policy::sha256_hex(&serde_json::to_vec(&envelope.params).unwrap_or_default());
    match state
        .store
        .lookup_receipt_json(&client_id, "sources.hint", &key)
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
            return match serde_json::from_str::<SourceHintResult>(&response) {
                Ok(result) => json(
                    StatusCode::OK,
                    &OkEnvelope {
                        ok: true,
                        request_id,
                        store_id,
                        result,
                    },
                ),
                Err(_) => fail_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    code::INTERNAL,
                    reason::INTERNAL_FAILURE,
                    false,
                    Some(&request_id),
                    Some(&store_id),
                ),
            };
        }
        Ok(None) => {}
        Err(error) => return core_response(error, &request_id, &store_id),
    }
    if !matches!(
        envelope.params.event.as_str(),
        "append" | "session-end" | "compaction"
    ) {
        return fail_response(
            StatusCode::BAD_REQUEST,
            code::INVALID_ARGUMENT,
            "INVALID_ARGUMENT",
            false,
            Some(&request_id),
            Some(&store_id),
        );
    }
    let now = now_ms();
    let row = match state.store.source_by_id(&envelope.params.source_id) {
        Ok(Some(row)) => row,
        Ok(None) => {
            return fail_response(
                StatusCode::PRECONDITION_FAILED,
                code::FAILED_PRECONDITION,
                "SOURCE_UNKNOWN",
                false,
                Some(&request_id),
                Some(&store_id),
            );
        }
        Err(error) => return core_response(error, &request_id, &store_id),
    };
    // A hint coalesces per source and event ID: repeated deliveries of the
    // same event are accepted without work.
    let event_key = format!("hint:{}", envelope.params.event_id);
    if let Ok(Some((_, stored))) =
        state
            .store
            .lookup_receipt_json(&client_id, "sources.event", &event_key)
    {
        let result = SourceHintResult {
            source_id: row.source_id.clone(),
            state: row.state.clone(),
            accepted: true,
            coalesced: true,
        };
        let _ = stored;
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
    let _ =
        state
            .store
            .mark_source_state(&row.source_id, "queued", None, None, row.pending_bytes, now);
    let _ = state.store.store_receipt_json(
        &client_id,
        "sources.event",
        &event_key,
        &hash,
        "\"ok\"",
        now,
    );
    if let Ok(response) = serde_json::to_string(&SourceHintResult {
        source_id: row.source_id.clone(),
        state: "queued".into(),
        accepted: true,
        coalesced: false,
    }) {
        let _ =
            state
                .store
                .store_receipt_json(&client_id, "sources.hint", &key, &hash, &response, now);
    }
    state.scheduler.wake();
    let result = SourceHintResult {
        source_id: row.source_id.clone(),
        state: "queued".into(),
        accepted: true,
        coalesced: false,
    };
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

pub async fn handle_extraction_retry(
    raw: &[u8],
    state: &Arc<State>,
    fallback_id: Option<String>,
) -> Resp {
    let envelope =
        match parse_route::<ExtractionRetryParams>(raw, fallback_id.as_deref(), &state.store_id) {
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
    let client_id = envelope.meta.client_id.clone();
    let key = envelope.params.idempotency_key.clone();
    let hash =
        lore_core::policy::sha256_hex(&serde_json::to_vec(&envelope.params).unwrap_or_default());
    match state
        .store
        .lookup_receipt_json(&client_id, "extraction.retry", &key)
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
            return match serde_json::from_str::<ExtractionRetryResult>(&response) {
                Ok(result) => json(
                    StatusCode::OK,
                    &OkEnvelope {
                        ok: true,
                        request_id,
                        store_id,
                        result,
                    },
                ),
                Err(_) => fail_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    code::INTERNAL,
                    reason::INTERNAL_FAILURE,
                    false,
                    Some(&request_id),
                    Some(&store_id),
                ),
            };
        }
        Ok(None) => {}
        Err(error) => return core_response(error, &request_id, &store_id),
    }
    let rule_version = envelope
        .params
        .rule_version
        .clone()
        .unwrap_or_else(|| RULE_VERSION.to_string());
    let now = now_ms();
    let reset = match state.store.reset_extraction_intents(&rule_version, now) {
        Ok(reset) => reset,
        Err(error) => return core_response(error, &request_id, &store_id),
    };
    let result = ExtractionRetryResult {
        reset,
        rule_version: rule_version.clone(),
    };
    if let Ok(response) = serde_json::to_string(&result) {
        let _ = state.store.store_receipt_json(
            &client_id,
            "extraction.retry",
            &key,
            &hash,
            &response,
            now,
        );
    }
    state.scheduler.wake();
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

pub async fn handle_status(raw: &[u8], state: &Arc<State>, fallback_id: Option<String>) -> Resp {
    let envelope =
        match parse_route::<SourceStatusParams>(raw, fallback_id.as_deref(), &state.store_id) {
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
    let params = envelope.params.clone();
    let limit = params.limit.clamp(1, 500) as usize;
    let filter = SourceFilter {
        client: params.client.clone(),
        repository: params.repository.clone(),
    };
    let store = Arc::clone(&state.store);
    let include_paths = params.include_paths;
    let cursor = params.cursor.clone();
    let observed_at = now_ms();
    let page = tokio::task::spawn_blocking(move || -> Result<(Vec<SourceStatusRecord>, Option<String>, SourceStatusCounts, i64), CoreError> {
        let rows = store.source_page(&filter, limit + 1, cursor.as_deref())?;
        let next_cursor = (rows.len() > limit).then(|| rows[limit - 1].source_id.clone());
        let counts = source_counts(&store)?;
        let mut records = Vec::with_capacity(rows.len().min(limit));
        for row in rows.into_iter().take(limit) {
            let normalized = store.source_record_count(&row.source_id, &row.generation)?;
            records.push(status_record(&row, normalized, include_paths));
        }
        let pending_extraction = store.extraction_pending()?;
        Ok((records, next_cursor, counts, pending_extraction))
    })
    .await;
    match page {
        Ok(Ok((sources, next_cursor, counts, pending_extraction))) => json(
            StatusCode::OK,
            &OkEnvelope {
                ok: true,
                request_id,
                store_id,
                result: SourceStatusResult {
                    next_cursor,
                    sources,
                    observed_at,
                    counts,
                    pending_extraction,
                },
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

fn status_record(row: &SourceRow, normalized: i64, include_paths: bool) -> SourceStatusRecord {
    SourceStatusRecord {
        source_id: row.source_id.clone(),
        client: row.client.clone(),
        root_id: row.root_id.clone(),
        native_session_id: row.native_session_id.clone(),
        repository: row.repository.clone(),
        repository_verified: row.repository_verified,
        state: row.state.clone(),
        generation: row.generation.clone(),
        generation_seq: row.generation_seq,
        observed_size: row.observed_size,
        offset: row.offset,
        pending_bytes: row.pending_bytes,
        capture_revision: row.offset,
        normalized_records: normalized,
        skipped_records: row.skipped_records,
        last_progress_ms: row.last_progress_ms,
        reason: row.last_error.clone(),
        path: include_paths.then(|| row.canonical_path.clone()),
    }
}

fn source_counts(store: &Store) -> Result<SourceStatusCounts, CoreError> {
    let mut counts = SourceStatusCounts {
        discovered: 0,
        caught_up: 0,
        growing: 0,
        unavailable: 0,
        ambiguous: 0,
        failed: 0,
        skipped: 0,
    };
    for (state, count) in store.source_counts()? {
        match state.as_str() {
            "discovered" | "eligible" | "queued" | "running" | "retry_wait" => {
                counts.discovered += count
            }
            "caught_up" => counts.caught_up += count,
            "growing" => counts.growing += count,
            "unavailable" => counts.unavailable += count,
            "ambiguous" => counts.ambiguous += count,
            "failed" => counts.failed += count,
            "skipped" => counts.skipped += count,
            _ => {}
        }
    }
    Ok(counts)
}

/// Status handler used by `/v2/status` for a compact source summary.
pub fn source_summary(store: &Store) -> Result<SourceStatusCounts, CoreError> {
    source_counts(store)
}
