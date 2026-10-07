//! Background embedding worker: reconciliation, claims, batches, retries and
//! the provider breaker. Runs on its own task and wakes on Retain.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use lore_core::store::{Store, jittered_backoff_ms};
use tokio::sync::Notify;

use crate::semantics::Semantics;

/// Breaker pause before retrying after consecutive transient failures.
pub const BREAKER_THRESHOLD: u32 = 3;
const RECONCILE_EVERY: Duration = Duration::from_secs(30);
const IDLE_WAIT: Duration = Duration::from_secs(1);
const LEASE_MS: i64 = 60_000;
const RENEW_EVERY: Duration = Duration::from_secs(5);
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(30);

/// Shared worker state exposed through Status.
pub struct WorkerState {
    status: Mutex<String>,
    last_error: Mutex<Option<String>>,
    resume: AtomicBool,
    dirty: AtomicBool,
}

impl Default for WorkerState {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkerState {
    pub fn new() -> Self {
        Self {
            status: Mutex::new("disabled".to_string()),
            last_error: Mutex::new(None),
            resume: AtomicBool::new(false),
            dirty: AtomicBool::new(true),
        }
    }

    pub fn status(&self) -> String {
        self.status.lock().expect("worker status").clone()
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().expect("worker error").clone()
    }

    /// Ask the worker to clear a pause (used by explicit retry/reload).
    pub fn request_resume(&self) {
        self.resume.store(true, Ordering::Release);
    }

    /// Mark that authoritative data changed and reconciliation should run now.
    pub fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
    }

    fn take_dirty(&self) -> bool {
        self.dirty.swap(false, Ordering::AcqRel)
    }

    fn update(&self, status: &str, error: Option<String>) {
        *self.status.lock().expect("worker status") = status.to_string();
        let mut last_error = self.last_error.lock().expect("worker error");
        match error {
            Some(error) => *last_error = Some(error),
            None if status == "ready" => *last_error = None,
            None => {}
        }
    }
}

/// Spawn the worker loop.
pub fn spawn(
    semantics: Arc<Semantics>,
    store: Arc<Store>,
    notify: Arc<Notify>,
    state: Arc<WorkerState>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let owner = format!("worker-{}", uuid::Uuid::new_v4());
        let mut consecutive_transient = 0u32;
        let mut pause_until: Option<Instant> = None;
        let mut last_reconcile = Instant::now()
            .checked_sub(RECONCILE_EVERY)
            .unwrap_or_else(Instant::now);
        loop {
            if state.resume.swap(false, Ordering::AcqRel) {
                pause_until = None;
                consecutive_transient = 0;
            }
            let Some(provider) = semantics.provider() else {
                state.update("disabled", None);
                wait(&notify, Duration::from_secs(2)).await;
                continue;
            };
            let Some(identity) = semantics.identity() else {
                state.update("disabled", None);
                wait(&notify, IDLE_WAIT).await;
                continue;
            };
            if let Some(until) = pause_until {
                if Instant::now() < until {
                    wait(&notify, Duration::from_millis(500)).await;
                    continue;
                }
                pause_until = None;
            }

            if last_reconcile.elapsed() >= RECONCILE_EVERY || state.take_dirty() {
                last_reconcile = Instant::now();
                let store_for = Arc::clone(&store);
                let identity_for = identity.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let cursor = store_for.reconciliation_cursor()?;
                    store_for.reconcile_page(&identity_for, cursor.as_deref(), 256, now_ms())
                })
                .await;
                if let Ok(Err(error)) = result {
                    state.update("ready", Some(error.reason.clone()));
                }
                continue;
            }

            let store_for = Arc::clone(&store);
            let owner_for = owner.clone();
            let claimed = tokio::task::spawn_blocking(move || {
                store_for.claim_job(&owner_for, now_ms(), LEASE_MS)
            })
            .await;
            let job = match claimed {
                Ok(Ok(Some(job))) => job,
                Ok(Ok(None)) => {
                    state.update("ready", None);
                    wait(&notify, IDLE_WAIT).await;
                    continue;
                }
                Ok(Err(error)) => {
                    state.update("ready", Some(error.reason.clone()));
                    wait(&notify, IDLE_WAIT).await;
                    continue;
                }
                Err(_) => {
                    wait(&notify, IDLE_WAIT).await;
                    continue;
                }
            };

            let renew = spawn_renewer(
                Arc::clone(&store),
                job.job_id.clone(),
                job.lease_token.clone(),
                owner.clone(),
            );
            let content = [job.content.clone()];
            let outcome = tokio::time::timeout(PROVIDER_TIMEOUT, provider.embed(&content)).await;
            renew.abort();

            match outcome {
                Ok(Ok(mut vectors)) => {
                    let vector = vectors.pop().unwrap_or_default();
                    let store_for = Arc::clone(&store);
                    let (job_id, token, owner_for) =
                        (job.job_id.clone(), job.lease_token.clone(), owner.clone());
                    let completed = tokio::task::spawn_blocking(move || {
                        store_for.complete_job(&job_id, &token, &owner_for, &vector, now_ms())
                    })
                    .await;
                    if let Ok(Ok(_)) = completed {
                        consecutive_transient = 0;
                        state.update("ready", None);
                    }
                }
                Ok(Err(error)) => {
                    let category = error.category().to_string();
                    let retryable = error.retryable();
                    if retryable {
                        consecutive_transient += 1;
                        if consecutive_transient >= BREAKER_THRESHOLD {
                            pause_until =
                                Some(Instant::now() + breaker_pause(consecutive_transient));
                            state.update("paused", Some(category.clone()));
                        }
                    } else {
                        consecutive_transient = 0;
                        let invalid = matches!(
                            category.as_str(),
                            "PROVIDER_AUTH"
                                | "PROVIDER_MODEL_INVALID"
                                | "PROVIDER_DIMENSIONS"
                                | "PROVIDER_CONFIG"
                        );
                        if invalid {
                            pause_until = Some(Instant::now() + Duration::from_secs(24 * 3600));
                            state.update("invalid", Some(category.clone()));
                        } else {
                            state.update("ready", Some(category.clone()));
                        }
                    }
                    record_failure(&store, &job, &owner, &category, retryable).await;
                }
                Err(_) => {
                    consecutive_transient += 1;
                    let category = "PROVIDER_OFFLINE".to_string();
                    if consecutive_transient >= BREAKER_THRESHOLD {
                        pause_until = Some(Instant::now() + breaker_pause(consecutive_transient));
                        state.update("paused", Some(category.clone()));
                    }
                    record_failure(&store, &job, &owner, &category, true).await;
                }
            }
        }
    })
}

async fn record_failure(
    store: &Arc<Store>,
    job: &lore_core::store::ClaimedJob,
    owner: &str,
    category: &str,
    retryable: bool,
) {
    let backoff = jittered_backoff_ms(job.attempts, 1_000, 60_000, seed());
    let store_for = Arc::clone(store);
    let (job_id, token, owner_for, category) = (
        job.job_id.clone(),
        job.lease_token.clone(),
        owner.to_string(),
        category.to_string(),
    );
    let _ = tokio::task::spawn_blocking(move || {
        store_for.fail_job(
            &job_id,
            &token,
            &owner_for,
            &category,
            retryable,
            Some(backoff),
            now_ms(),
        )
    })
    .await;
}

fn spawn_renewer(
    store: Arc<Store>,
    job_id: String,
    lease_token: String,
    owner: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(RENEW_EVERY).await;
            let store_for = Arc::clone(&store);
            let (job_id, lease_token, owner) = (job_id.clone(), lease_token.clone(), owner.clone());
            let renewed = tokio::task::spawn_blocking(move || {
                store_for.renew_job(&job_id, &lease_token, &owner, now_ms(), LEASE_MS)
            })
            .await;
            if !matches!(renewed, Ok(Ok(true))) {
                break;
            }
        }
    })
}

fn breaker_pause(consecutive: u32) -> Duration {
    Duration::from_secs(u64::from(
        (30 * consecutive.saturating_sub(2)).clamp(30, 60),
    ))
}

async fn wait(notify: &Notify, duration: Duration) {
    tokio::select! {
        _ = notify.notified() => {}
        _ = tokio::time::sleep(duration) => {}
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos() as u64)
        .unwrap_or(1)
}
