/**
 * coherence-doctor.mjs — observe-only incident classifier for the Coherence stack.
 *
 * Reads signals from already-available surfaces (maintenance task states,
 * trajectory artifacts, improvement artifact counts, and session-start latency
 * metrics), classifies them into typed incidents, and optionally records an
 * additive doctor-report trajectory artifact.  No trusted-source mutation occurs.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Incident kind constants
// ---------------------------------------------------------------------------

export const INCIDENT_KINDS = Object.freeze({
  MAINTENANCE_TASK_FAILED: "maintenance_task_failed",
  MAINTENANCE_TASK_ATTENTION: "maintenance_task_attention",
  REPLAY_CORPUS_ATTENTION: "replay_corpus_attention",
  VALIDATION_CORPUS_ATTENTION: "validation_corpus_attention",
  TRAJECTORY_REPLAY_FAILURES: "trajectory_replay_failures",
  TRAJECTORY_VALIDATION_MISSES: "trajectory_validation_misses",
  TRAJECTORY_LATENCY_OUTLIERS: "trajectory_latency_outliers",
  LATENCY_WARNING: "latency_warning",
  BACKLOG_STALE: "backlog_stale",
  UNANSWERED_WORK_STALL: "unanswered_work_stall",
  PROPOSAL_REVIEW_FINDING: "proposal_review_finding",
});

const SEVERITY_RANK = Object.freeze({ critical: 3, warning: 2, info: 1 });
const STALL_WINDOWS_HOURS = Object.freeze({
  maintenance: 24,
  deferredRunning: 2,
  deferredDue: 6,
});

function nowIso() {
  return new Date().toISOString();
}

function clampLimit(value, fallback, { min = 1, max = 50 } = {}) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.round(numeric))) : fallback;
}

// ---------------------------------------------------------------------------
// Proposal-doc structural review helpers (observe-only, no mutation)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const PROPOSAL_REQUIRED_SECTIONS = [
  { key: "goal", patterns: ["goal", "objective", "overview"] },
  { key: "acceptance", patterns: ["acceptance", "criteria", "done when", "success criteria"] },
  { key: "risk", patterns: ["risk", "constraint", "caveat", "limitation"] },
];

function checkProposalSections(text) {
  const found = new Set();
  let inFence = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = trimmed.match(/^#{1,6}\s+(.+?)(?:\s+#+\s*)?$/);
    if (m) {
      const h = m[1].toLowerCase();
      for (const s of PROPOSAL_REQUIRED_SECTIONS) {
        if (s.patterns.some((p) => h.includes(p))) found.add(s.key);
      }
    }
  }
  const lower = text.toLowerCase();
  for (const s of PROPOSAL_REQUIRED_SECTIONS) {
    if (s.patterns.some((p) => lower.includes(`${p}:`))) found.add(s.key);
  }
  return PROPOSAL_REQUIRED_SECTIONS.map((s) => s.key).filter((k) => !found.has(k));
}

function readProposalSignals(db, { limit = 5 } = {}) {
  const rows = db.listImprovementArtifacts({ status: "active", hasProposal: true, limit });
  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? "",
    proposalPath: row.proposal_path ?? null,
    reviewState: row.review_state ?? "none",
  }));
}

function classifyProposalReview(proposals) {
  const incidents = [];
  for (const p of proposals) {
    if (!p.proposalPath) continue;
    let text;
    try {
      text = readFileSync(path.join(REPO_ROOT, p.proposalPath), "utf8");
    } catch (err) {
      incidents.push({
        kind: INCIDENT_KINDS.PROPOSAL_REVIEW_FINDING,
        severity: "info",
        summary: `Proposal file for '${p.title}' could not be read (${err.code ?? err.message})`,
        context: {
          improvementArtifactId: p.id,
          proposalPath: p.proposalPath,
          reviewState: p.reviewState,
          unreadable: true,
          errorCode: err.code ?? null,
        },
      });
      continue;
    }
    if (!text.trim()) continue;
    const missing = checkProposalSections(text);
    if (missing.length === 0) continue;
    incidents.push({
      kind: INCIDENT_KINDS.PROPOSAL_REVIEW_FINDING,
      severity: "info",
      summary: `Proposal for '${p.title}' is missing section(s): ${missing.join(", ")}`,
      context: {
        improvementArtifactId: p.id,
        proposalPath: p.proposalPath,
        reviewState: p.reviewState,
        missingSections: missing,
      },
    });
  }
  return incidents;
}

// ---------------------------------------------------------------------------
// Signal readers — all read-only DB or metric queries
// ---------------------------------------------------------------------------

function readMaintenanceSignals(db) {
  const taskStates = db.listMaintenanceTaskStates();
  return taskStates.map((state) => ({
    taskName: state.task_name,
    lastStatus: state.last_status,
    totalFailures: state.total_failures ?? 0,
    totalNeedsAttention: state.total_needs_attention ?? 0,
    totalRuns: state.total_runs ?? 0,
    lastSummary: state.lastSummary ?? {},
    lastCompletedAt: state.last_completed_at ?? null,
  }));
}

function readTrajectorySignals(db, { repository, limit } = {}) {
  const recent = db.listTrajectoryArtifacts({ repository, limit });
  const counts = {
    replay_failure: 0,
    validation_miss: 0,
    latency_outlier: 0,
    other: 0,
  };
  for (const row of recent) {
    if (row.kind === "replay_failure") {
      counts.replay_failure += 1;
    } else if (row.kind === "validation_miss") {
      counts.validation_miss += 1;
    } else if (row.kind === "latency_outlier") {
      counts.latency_outlier += 1;
    } else {
      counts.other += 1;
    }
  }
  return { recent, counts };
}

function readStatsSignals(db) {
  return db.getStats();
}

function readLatencySignals(metrics) {
  if (!metrics) {
    return null;
  }
  const sessionStart = metrics.sessionStart ?? null;
  if (!sessionStart) {
    return null;
  }
  return {
    p95Ms: sessionStart.p95Ms ?? null,
    targetMs: sessionStart.targetMs ?? null,
    samples: sessionStart.samples ?? 0,
    exceedsTarget: sessionStart.p95Ms != null
      && sessionStart.targetMs != null
      && sessionStart.p95Ms > sessionStart.targetMs,
  };
}

function readUnansweredStallSignals(db, { repository } = {}) {
  const repo = typeof repository === "string" && repository.trim().length > 0
    ? repository.trim()
    : null;
  const staleMaintenanceCount = db.db.prepare(`
    SELECT COUNT(*) AS count
    FROM maintenance_task_state
    WHERE last_status IN ('failed', 'needs_attention')
      AND (last_completed_at IS NULL OR last_completed_at <= datetime('now', ?))
  `).get(`-${STALL_WINDOWS_HOURS.maintenance} hours`)?.count ?? 0;

  const stalledDeferredRunningCount = db.db.prepare(`
    SELECT COUNT(*) AS count
    FROM deferred_extraction
    WHERE status = 'running'
      AND started_at IS NOT NULL
      AND started_at <= datetime('now', ?)
      AND (? IS NULL OR repository = ? OR repository IS NULL OR repository = '')
  `).get(
    `-${STALL_WINDOWS_HOURS.deferredRunning} hours`,
    repo,
    repo,
  )?.count ?? 0;

  const staleDeferredDueCount = db.db.prepare(`
    SELECT COUNT(*) AS count
    FROM deferred_extraction
    WHERE status IN ('pending', 'failed')
      AND available_at <= datetime('now', ?)
      AND (? IS NULL OR repository = ? OR repository IS NULL OR repository = '')
  `).get(
    `-${STALL_WINDOWS_HOURS.deferredDue} hours`,
    repo,
    repo,
  )?.count ?? 0;

  return {
    staleMaintenanceCount,
    stalledDeferredRunningCount,
    staleDeferredDueCount,
  };
}

// ---------------------------------------------------------------------------
// Classifiers — each returns a (possibly empty) array of incidents
// ---------------------------------------------------------------------------

function classifyMaintenanceTasks(taskStates) {
  const incidents = [];
  for (const state of taskStates) {
    if (state.lastStatus === "failed") {
      incidents.push({
        kind: INCIDENT_KINDS.MAINTENANCE_TASK_FAILED,
        severity: "critical",
        summary: `Maintenance task '${state.taskName}' last run failed (totalFailures=${state.totalFailures}, totalRuns=${state.totalRuns})`,
        context: {
          taskName: state.taskName,
          lastStatus: state.lastStatus,
          totalFailures: state.totalFailures,
          totalRuns: state.totalRuns,
          lastCompletedAt: state.lastCompletedAt,
          lastSummaryError: state.lastSummary?.error ?? null,
        },
      });
    } else if (state.lastStatus === "needs_attention") {
      const replayFailures = state.lastSummary?.mustPassFailed ?? 0;
      const validationFailed = state.lastSummary?.failed ?? 0;
      if (state.taskName === "replayCorpus" && replayFailures > 0) {
        incidents.push({
          kind: INCIDENT_KINDS.REPLAY_CORPUS_ATTENTION,
          severity: "warning",
          summary: `Replay corpus reported ${replayFailures} must-pass failure(s) in last run`,
          context: {
            taskName: state.taskName,
            mustPassFailed: replayFailures,
            rankingTargetPartial: state.lastSummary?.rankingTargetPartial ?? 0,
            rankingTargetMissing: state.lastSummary?.rankingTargetMissing ?? 0,
            caseIds: state.lastSummary?.caseIds ?? [],
            lastCompletedAt: state.lastCompletedAt,
          },
        });
      } else if (state.taskName === "validationCorpus" && validationFailed > 0) {
        incidents.push({
          kind: INCIDENT_KINDS.VALIDATION_CORPUS_ATTENTION,
          severity: "warning",
          summary: `Validation corpus reported ${validationFailed} failure(s) in last run`,
          context: {
            taskName: state.taskName,
            failed: validationFailed,
            total: state.lastSummary?.total ?? 0,
            caseIds: state.lastSummary?.caseIds ?? [],
            lastCompletedAt: state.lastCompletedAt,
          },
        });
      } else {
        incidents.push({
          kind: INCIDENT_KINDS.MAINTENANCE_TASK_ATTENTION,
          severity: "info",
          summary: `Maintenance task '${state.taskName}' reported needs_attention (totalNeedsAttention=${state.totalNeedsAttention})`,
          context: {
            taskName: state.taskName,
            lastStatus: state.lastStatus,
            totalNeedsAttention: state.totalNeedsAttention,
            totalRuns: state.totalRuns,
            lastCompletedAt: state.lastCompletedAt,
          },
        });
      }
    }
  }
  return incidents;
}

function classifyTrajectorySignals(signals) {
  const incidents = [];
  if (signals.counts.replay_failure > 0) {
    incidents.push({
      kind: INCIDENT_KINDS.TRAJECTORY_REPLAY_FAILURES,
      severity: signals.counts.replay_failure >= 3 ? "warning" : "info",
      summary: `${signals.counts.replay_failure} replay-failure trajectory artifact(s) recorded recently`,
      context: { recentReplayFailures: signals.counts.replay_failure },
    });
  }
  if (signals.counts.validation_miss > 0) {
    incidents.push({
      kind: INCIDENT_KINDS.TRAJECTORY_VALIDATION_MISSES,
      severity: signals.counts.validation_miss >= 3 ? "warning" : "info",
      summary: `${signals.counts.validation_miss} validation-miss trajectory artifact(s) recorded recently`,
      context: { recentValidationMisses: signals.counts.validation_miss },
    });
  }
  if (signals.counts.latency_outlier > 0) {
    incidents.push({
      kind: INCIDENT_KINDS.TRAJECTORY_LATENCY_OUTLIERS,
      severity: "info",
      summary: `${signals.counts.latency_outlier} latency-outlier trajectory artifact(s) recorded recently`,
      context: { recentLatencyOutliers: signals.counts.latency_outlier },
    });
  }
  return incidents;
}

function classifyLatency(latencySignals) {
  if (!latencySignals || !latencySignals.exceedsTarget) {
    return [];
  }
  return [
    {
      kind: INCIDENT_KINDS.LATENCY_WARNING,
      severity: "warning",
      summary: `Session-start P95 latency ${Math.round(latencySignals.p95Ms)}ms exceeds target ${Math.round(latencySignals.targetMs)}ms`,
      context: {
        p95Ms: Math.round(latencySignals.p95Ms),
        targetMs: Math.round(latencySignals.targetMs),
        samples: latencySignals.samples,
      },
    },
  ];
}

function classifyBacklogStats(stats) {
  const active = stats.improvementActiveCount ?? 0;
  const proposal = stats.improvementProposalCount ?? 0;
  if (active > 20) {
    return [
      {
        kind: INCIDENT_KINDS.BACKLOG_STALE,
        severity: "info",
        summary: `Evolution ledger has ${active} active artifacts (${proposal} with proposals); consider a backlog review`,
        context: {
          improvementActiveCount: active,
          improvementProposalCount: proposal,
          improvementResolvedCount: stats.improvementResolvedCount ?? 0,
        },
      },
    ];
  }
  return [];
}

function classifyUnansweredWorkStall(signals) {
  const total = signals.staleMaintenanceCount
    + signals.stalledDeferredRunningCount
    + signals.staleDeferredDueCount;
  if (total === 0) {
    return [];
  }
  const severity = signals.stalledDeferredRunningCount > 0 || signals.staleMaintenanceCount > 0
    ? "warning"
    : "info";
  return [
    {
      kind: INCIDENT_KINDS.UNANSWERED_WORK_STALL,
      severity,
      summary: `Detected ${total} stalled/unanswered work signal(s) from maintenance/deferred queues`,
      context: {
        staleMaintenanceCount: signals.staleMaintenanceCount,
        stalledDeferredRunningCount: signals.stalledDeferredRunningCount,
        staleDeferredDueCount: signals.staleDeferredDueCount,
        maintenanceWindowHours: STALL_WINDOWS_HOURS.maintenance,
        deferredRunningWindowHours: STALL_WINDOWS_HOURS.deferredRunning,
        deferredDueWindowHours: STALL_WINDOWS_HOURS.deferredDue,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Report summary builder
// ---------------------------------------------------------------------------

function summarizeIncidents(incidents) {
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const inc of incidents) {
    const rank = SEVERITY_RANK[inc.severity] ?? 1;
    if (rank >= SEVERITY_RANK.critical) {
      critical += 1;
    } else if (rank >= SEVERITY_RANK.warning) {
      warning += 1;
    } else {
      info += 1;
    }
  }
  return { critical, warning, info };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the observe-only doctor pass.  Reads existing signals, classifies
 * incidents, and optionally records an additive trajectory artifact.
 *
 * @param {object} options
 * @param {object} options.runtime  - The active Coherence runtime
 * @param {string|null} [options.repository] - Current repository scope
 * @param {boolean} [options.dryRun=false] - If true, skip recording the artifact
 * @param {number} [options.trajectoryLimit=20] - Max trajectory artifacts to scan
 * @returns {{ generatedAt, repository, incidentCount, criticalCount, warningCount,
 *             infoCount, incidents, signals, recordedArtifactId }}
 */
export function runDoctorObservation({
  runtime,
  repository = null,
  dryRun = false,
  trajectoryLimit = 20,
} = {}) {
  const generatedAt = nowIso();
  const boundedLimit = clampLimit(trajectoryLimit, 20);

  // --- collect signals ---
  const maintenanceSignals = readMaintenanceSignals(runtime.db);
  const trajectorySignals = readTrajectorySignals(runtime.db, {
    repository: repository ?? undefined,
    limit: boundedLimit,
  });
  const statsSignals = readStatsSignals(runtime.db);
  const latencySignals = readLatencySignals(runtime.metrics ?? null);
  const proposalSignals = readProposalSignals(runtime.db);
  const unansweredStallSignals = readUnansweredStallSignals(runtime.db, {
    repository: repository ?? undefined,
  });

  // --- classify ---
  const incidents = [
    ...classifyMaintenanceTasks(maintenanceSignals),
    ...classifyTrajectorySignals(trajectorySignals),
    ...classifyLatency(latencySignals),
    ...classifyBacklogStats(statsSignals),
    ...classifyProposalReview(proposalSignals),
    ...classifyUnansweredWorkStall(unansweredStallSignals),
  ];

  // Sort most-severe first for predictable output
  incidents.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 1) - (SEVERITY_RANK[a.severity] ?? 1));

  const { critical, warning, info } = summarizeIncidents(incidents);

  // --- optionally record additive artifact ---
  let recordedArtifactId = null;
  if (!dryRun && incidents.length > 0) {
    const overallSeverity = critical > 0 ? "critical" : warning > 0 ? "warning" : "info";
    const summaryLine = incidents.length === 1
      ? incidents[0].summary
      : `${incidents.length} incident(s) classified: ${critical} critical, ${warning} warning, ${info} info`;
    try {
      recordedArtifactId = runtime.db.insertTrajectoryArtifact({
        kind: "doctor_report",
        repository: repository ?? null,
        sourceKind: "doctor",
        summary: summaryLine,
        severity: overallSeverity,
        outcome: "observed",
        context: {
          incidentCount: incidents.length,
          criticalCount: critical,
          warningCount: warning,
          infoCount: info,
          incidentKinds: incidents.map((inc) => inc.kind),
        },
        trace: {
          maintenanceTaskCount: maintenanceSignals.length,
          trajectoryScanned: trajectorySignals.recent.length,
          latencyChecked: latencySignals != null,
          proposalScanned: proposalSignals.length,
          unansweredWorkSignals: unansweredStallSignals,
        },
      });
    } catch {
      // artifact recording is best-effort; never block diagnosis
    }
  }

  return {
    generatedAt,
    repository,
    incidentCount: incidents.length,
    criticalCount: critical,
    warningCount: warning,
    infoCount: info,
    incidents,
    signals: {
      maintenanceTaskCount: maintenanceSignals.length,
      trajectoryRecentCount: trajectorySignals.recent.length,
      trajectoryCounts: trajectorySignals.counts,
      latency: latencySignals,
      improvementActiveCount: statsSignals.improvementActiveCount ?? 0,
      unansweredWorkStall: unansweredStallSignals,
    },
    recordedArtifactId,
  };
}
