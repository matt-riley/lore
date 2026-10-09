//! Maintenance task runner and the scheduler tick that claims due work.
//!
//! State lives in the store (`maintenance_task_state` / `maintenance_runs`);
//! this module owns what each task actually does. Hygiene runs in shadow mode
//! and only a manual apply marks candidates, recording the exact ids and
//! revisions needed for an exact rollback.

use std::sync::Arc;
use std::time::Duration;

use lore_core::config::ResolvedMaintenance;
use lore_core::store::Store;
use serde_json::{Value, json};

/// One task outcome before it is written to the run row.
pub struct TaskOutcome {
    pub state: &'static str,
    pub completed: i64,
    pub failed: i64,
    pub needs_attention: i64,
    pub detail: Value,
}

impl TaskOutcome {
    fn ok(completed: i64, needs_attention: i64, detail: Value) -> Self {
        Self {
            state: "complete",
            completed,
            failed: 0,
            needs_attention,
            detail,
        }
    }

    fn failed(reason: &str) -> Self {
        Self {
            state: "failed",
            completed: 0,
            failed: 1,
            needs_attention: 0,
            detail: json!({ "error": reason }),
        }
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// How many candidates a bounded maintenance pass considers.
const PASS_LIMIT: usize = 100;

/// Run one task. Manual applies may mutate only the tasks that own durable
/// markers; everything else stays observe-only.
pub fn run_task(
    store: &Store,
    run_id: &str,
    task: &str,
    dry_run: bool,
    now_ms: i64,
) -> TaskOutcome {
    match task {
        "memoryHygiene" => run_hygiene(store, run_id, dry_run, now_ms),
        "deferredExtraction" => {
            if dry_run {
                let pending = store.extraction_pending().unwrap_or(0);
                TaskOutcome::ok(0, pending, json!({ "pending": pending }))
            } else {
                let report = crate::sources::extract_pending(store, 16, now_ms);
                TaskOutcome::ok(
                    report.applied as i64,
                    report.failed as i64,
                    json!({
                        "claimed": report.claimed,
                        "applied": report.applied,
                        "suppressed": report.suppressed,
                        "failed": report.failed,
                    }),
                )
            }
        }
        "validationCorpus" => match store.admin_validate(true) {
            Ok(value) => TaskOutcome::ok(
                1,
                0,
                json!({ "ok": value["ok"], "findings": value["findings"] }),
            ),
            Err(error) => TaskOutcome::failed(&error.reason),
        },
        "replayCorpus" => match store.replay_run(160, None) {
            Ok(value) => {
                let failed = value["failed"].as_i64().unwrap_or(0);
                TaskOutcome::ok(value["passed"].as_i64().unwrap_or(0), failed, value)
            }
            Err(error) => TaskOutcome::failed(&error.reason),
        },
        "backlogReview" => match store.review_gate(now_ms) {
            Ok(value) => {
                let proposed = value["counts"]["proposed"].as_i64().unwrap_or(0);
                TaskOutcome::ok(0, proposed, value)
            }
            Err(error) => TaskOutcome::failed(&error.reason),
        },
        "traceCompaction" => {
            // Retrieval traces are intentionally not persisted; the task
            // reports that bounded truth instead of inventing work.
            TaskOutcome::ok(
                0,
                0,
                json!({ "note": "retrieval traces are not persisted in v2" }),
            )
        }
        "indexUpkeep" => run_index_upkeep(store, dry_run, now_ms),
        "doctorSnapshot" => match store.admin_doctor(true, 10) {
            Ok(value) => {
                if dry_run {
                    return TaskOutcome::ok(
                        0,
                        0,
                        json!({ "dryRun": true, "hints": value["hints"] }),
                    );
                }
                let dir = store.data_dir().join("trajectory");
                if let Err(error) = std::fs::create_dir_all(&dir) {
                    return TaskOutcome::failed(&error.to_string());
                }
                let path = dir.join(format!("doctor-snapshot-{run_id}.json"));
                match std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap_or_default()) {
                    Ok(()) => TaskOutcome::ok(1, 0, json!({ "path": path.display().to_string() })),
                    Err(error) => TaskOutcome::failed(&error.to_string()),
                }
            }
            Err(error) => TaskOutcome::failed(&error.reason),
        },
        "extractionRevalidation" => {
            let report = store
                .admin_audit_extractions()
                .unwrap_or(json!({ "sources": [] }));
            let pending: Vec<Value> = report["sources"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|source| source["extractionState"] == "complete")
                .filter(|source| source["revalidated"] == false)
                .take(PASS_LIMIT)
                .map(|source| {
                    json!({
                        "sourceId": source["sourceId"],
                        "generation": source["generation"],
                    })
                })
                .collect();
            TaskOutcome::ok(
                0,
                pending.len() as i64,
                json!({ "awaitingRevalidation": pending }),
            )
        }
        other => TaskOutcome::failed(&format!("unknown maintenance task: {other}")),
    }
}

fn run_hygiene(store: &Store, run_id: &str, dry_run: bool, now_ms: i64) -> TaskOutcome {
    let candidates = match store.hygiene_candidates(now_ms, PASS_LIMIT) {
        Ok(candidates) => candidates,
        Err(error) => return TaskOutcome::failed(&error.reason),
    };
    if dry_run {
        return TaskOutcome::ok(
            0,
            candidates.len() as i64,
            json!({ "candidates": candidates }),
        );
    }
    if candidates.is_empty() {
        return TaskOutcome::ok(0, 0, json!({ "applied": [] }));
    }
    let marker = format!("hygiene-auto:{run_id}");
    match store.hygiene_apply(&candidates, &marker, now_ms) {
        Ok(applied) => TaskOutcome::ok(
            applied as i64,
            0,
            json!({ "marker": marker, "applied": candidates }),
        ),
        Err(error) => TaskOutcome::failed(&error.reason),
    }
}

/// Roll back one hygiene run exactly: the recorded ids are un-forgotten and
/// only that run's suppression marker is removed.
pub fn rollback_hygiene(store: &Store, run_id: &str) -> Result<i64, String> {
    store.hygiene_rollback(run_id).map_err(|error| error.reason)
}

fn run_index_upkeep(store: &Store, dry_run: bool, now_ms: i64) -> TaskOutcome {
    let reaped = if dry_run {
        store.embedding_counts_stale(now_ms).unwrap_or(0)
    } else {
        store.reap_expired_jobs(now_ms).unwrap_or(0) as i64
    };
    let stale_vectors = if dry_run {
        store.stale_vector_count().unwrap_or(0)
    } else {
        store.drop_stale_vectors().unwrap_or(0)
    };
    TaskOutcome::ok(
        reaped + stale_vectors,
        0,
        json!({ "reapedJobs": reaped, "staleVectors": stale_vectors }),
    )
}

/// Claim and run every due task once. Returns the run ids started, so both
/// the scheduler and tests can observe the tick.
pub fn maintenance_tick(
    store: &Store,
    maintenance: &ResolvedMaintenance,
    scope: &str,
    now_ms: i64,
) -> Vec<String> {
    let mut started = Vec::new();
    if store.maintenance_sync(maintenance, scope, now_ms).is_err() {
        return started;
    }
    let due = store.maintenance_due(scope, now_ms).unwrap_or_default();
    for task in due {
        let run_id = match store.maintenance_claim(&task.task, scope, "scheduled", false, now_ms) {
            Ok(Some(run_id)) => run_id,
            _ => continue,
        };
        let outcome = run_task(store, &run_id, &task.task, false, now_ms);
        let _ = store.maintenance_finish(
            &run_id,
            outcome.state,
            outcome.completed,
            outcome.failed,
            outcome.needs_attention,
            Some(outcome.detail),
            now_ms,
        );
        started.push(run_id);
    }
    started
}

/// Spawn the maintenance scheduler thread.
pub fn spawn(store: Arc<Store>, maintenance: ResolvedMaintenance, scope: String) {
    std::thread::Builder::new()
        .name("lore-maintenance".into())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(15));
                let _ = maintenance_tick(&store, &maintenance, &scope, now());
            }
        })
        .expect("spawn maintenance scheduler");
}
