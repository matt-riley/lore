import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applySessionExtraction,
} from "../../lib/backfill.mjs";
import { createMemoryTools } from "../../lib/memory-tools.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";
import { findTool, buildBackfillRuntime as buildRuntime } from "../helpers/tool-helpers.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function buildSessionArtifacts({
  sessionSummary,
  turns,
  repository = "fixture-repo",
}) {
  return {
    session: {
      repository,
      branch: "main",
      summary: sessionSummary,
      updated_at: "2024-04-02T12:00:00.000Z",
    },
    checkpoints: [],
    files: [],
    refs: [],
    turns: turns.map((turn, index) => ({
      turn_index: index + 1,
      user_message: turn.user_message,
      assistant_response: turn.assistant_response ?? "",
    })),
  };
}

describe("backfill extraction and progress reporting", () => {
  test("applySessionExtraction stores assistant-goal improvement artifacts with stable content", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          autoWriteImprovementGoals: true,
        },
      },
    });
    try {
      applySessionExtraction({
        db,
        sessionId: "session-assistant-goal",
        repository: "fixture-repo",
        sessionArtifacts: buildSessionArtifacts({
          sessionSummary: "Routine capture session",
          turns: [
            {
              user_message: "Help me reduce backfill hotspot complexity without changing artifact output",
            },
          ],
        }),
        workspace: { workspace: null },
      });

      const artifacts = db.listImprovementArtifacts({
        sourceKind: "session",
        limit: 10,
      });

      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].source_case_id, "session:assistant_goal:repo:fixture-repo:assistant_goal:reduce backfill hotspot complexity without changing artifact output");
      assert.equal(artifacts[0].title, "Session-derived assistant goal");
      assert.equal(artifacts[0].summary, "Goal: reduce backfill hotspot complexity without changing artifact output");
      assert.ok(artifacts[0].linked_memory_id);
      assert.deepStrictEqual(artifacts[0].evidence, {
        sessionId: "session-assistant-goal",
        repository: "fixture-repo",
        memoryType: "assistant_goal",
        signalType: null,
        sourceTurnIndex: 1,
        content: "Current assistant goal: reduce backfill hotspot complexity without changing artifact output",
        goal: "reduce backfill hotspot complexity without changing artifact output",
        examples: [],
        tags: ["assistant-goal", "session-goal", "user"],
      });
      assert.deepStrictEqual(artifacts[0].trace, {
        episodeSummary: "Routine capture session",
        themes: ["fixture", "repo", "routine", "capture", "session"],
      });
    } finally {
      cleanup();
    }
  });

  test("applySessionExtraction stores inferred recurring-mistake improvement artifacts with repo fallback", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          autoWriteImprovementGoals: true,
        },
      },
    });
    try {
      applySessionExtraction({
        db,
        sessionId: "session-recurring-mistake",
        repository: "fixture-repo",
        sessionArtifacts: buildSessionArtifacts({
          sessionSummary: "Routine correction session",
          turns: [
            {
              user_message: "No, keep the artifact content unchanged while refactoring.",
            },
            {
              user_message: "Still, stop touching other production files in this lane.",
            },
          ],
        }),
        workspace: { workspace: null },
      });

      const artifacts = db.listImprovementArtifacts({
        sourceKind: "session",
        limit: 10,
      });

      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].source_case_id, "session:recurring_mistake:global:fixture-repo:recurring_mistake:missing or overriding explicit user corrections before continuing implementation");
      assert.equal(artifacts[0].title, "Session-inferred recurring mistake");
      assert.equal(artifacts[0].summary, "Mistake: missing or overriding explicit user corrections before continuing implementation");
      assert.ok(artifacts[0].linked_memory_id);
      assert.deepStrictEqual(artifacts[0].evidence, {
        sessionId: "session-recurring-mistake",
        repository: "fixture-repo",
        memoryType: "recurring_mistake",
        signalType: "repeated_correction",
        sourceTurnIndex: 2,
        content: "Recurring mistake to avoid: missing or overriding explicit user corrections before continuing implementation.",
        mistake: "missing or overriding explicit user corrections before continuing implementation",
        examples: [
          "keep the artifact content unchanged while refactoring.",
          "stop touching other production files in this lane.",
        ],
        tags: ["recurring-mistake", "feedback", "implicit-session", "correction-pattern"],
      });
      assert.deepStrictEqual(artifacts[0].trace, {
        episodeSummary: "Routine correction session",
        themes: ["fixture", "repo", "routine", "correction", "session"],
      });
    } finally {
      cleanup();
    }
  });

  test("maintenance status report includes additive progress summary fields", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        deferredExtraction: {
          enabled: true,
        },
        maintenanceScheduler: {
          enabled: true,
          autoRunOnSessionStart: true,
        },
      },
    });
    try {
      const runtime = buildRuntime(db, config);
      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const output = await findTool(tools, "maintenance_schedule_run").handler({
        action: "status",
      }, {
        sessionId: "session-maintenance-status",
      });

      assert.match(output, /progressTotalCount:/);
      assert.match(output, /progressPendingCount:/);
      assert.match(output, /progressPercent:/);
      assert.match(output, /currentPhase: planning/);
    } finally {
      cleanup();
    }
  });

  test("memory_status reports deferred/backfill current-phase summaries", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });
    try {
      db.enqueueDeferredExtraction({
        sessionId: "deferred-progress-1",
        repository: "fixture-repo",
        reason: "test",
      });

      const runtime = buildRuntime(db, config);
      runtime.metrics = {
        sessionStart: {
          p50Ms: 12,
          p95Ms: 20,
          averageMs: 14,
          maxMs: 25,
          latestMs: 18,
          samples: 7,
          readiness: "ready",
          minSamples: 5,
          targetMs: 100,
          targetStatus: "meeting_target",
          recentAverageMs: 16,
          previousAverageMs: 10,
          trend: "up",
          trendDeltaMs: 6,
        },
        userPromptSubmitted: null,
      };
      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const output = await findTool(tools, "memory_status").handler({}, {
        sessionId: "session-memory-status",
      });

      assert.match(output, /deferredActionableCount: 1/);
      assert.match(output, /deferredCurrentPhase: queued/);
      assert.match(output, /backfillCurrentPhase: idle/);
      assert.match(output, /sessionStartP50Ms: 12/);
      assert.match(output, /sessionStartTrendDeltaMs: 6/);
    } finally {
      cleanup();
    }
  });

  test("memory_status renders recent trace and trajectory sections when requested", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });
    try {
      const runtime = buildRuntime(db, config);
      runtime.traceRecorder = {
        getStats() {
          return {
            storedRecords: 1,
            totalRecorded: 2,
            totalEvicted: 0,
            totalExpired: 0,
            maxRecords: 100,
            maxAgeMs: 60000,
            lastRecordedAt: "2024-04-05T11:00:00.000Z",
            routes: [{ route: "memory_recall", count: 1 }],
            lookupHitRates: [{ name: "localEpisodes", includedRate: 1, includedCount: 1, seenCount: 1 }],
            repeatedWins: [{ label: "recent_work", count: 1 }],
            repeatedMisses: [],
            hooks: [{
              hook: "onUserPromptSubmitted",
              samples: 1,
              withContextCount: 1,
              withoutContextCount: 0,
              p50Ms: 11,
              p95Ms: 11,
              averageMs: 11,
              maxMs: 11,
              trend: "flat",
              trendDeltaMs: 0,
            }],
          };
        },
        getRecent() {
          return [{
            id: "trace-1",
            hook: "onUserPromptSubmitted",
            recordedAt: "2024-04-05T11:00:00.000Z",
            repository: "fixture-repo",
            promptPreview: "continue diagnostics work",
            latencyMs: 17,
            routerDecision: {
              route: "memory_recall",
              reason: "context_match",
            },
            output: {
              contextInjected: true,
              sectionTitles: ["Recent Related Work"],
              injectedContextPreview: "## Recent Related Work",
            },
            eligibility: {
              local: ["repo:fixture-repo"],
              crossRepo: ["transferable"],
            },
            promptNeed: {
              requiresLookup: true,
              wantsContinuity: true,
              allowCrossRepoFallback: true,
              identityOnly: false,
            },
            lookups: {
              localEpisodes: {
                matchedCount: 2,
                includedCount: 1,
                droppedCount: 1,
                reason: "included_match",
                includedRows: [{ type: "episode", text: "Added diagnostics rendering coverage", repository: "fixture-repo" }],
                matchedRows: [{ type: "episode", text: "Added diagnostics rendering coverage", repository: "fixture-repo" }],
                droppedRows: [{ stage: "rank", reason: "cutoff", row: { text: "Older note" } }],
              },
            },
            omissions: [{ stage: "style", reason: "suppressed_for_temporal_prompt" }],
          }];
        },
      };
      runtime.db.listTrajectoryArtifacts = () => [{
        id: "traj-1",
        kind: "validation_failure",
        source_kind: "validation",
        source_case_id: "identity-greeting",
        severity: "warning",
        outcome: "recorded",
        latency_ms: 19,
        target_ms: 50,
        improvement_artifact_id: "imp-1",
        event_key: "identity-greeting",
        context: { prompt: true },
        summary: "Identity validation drift",
        created_at: "2024-04-05T11:01:00.000Z",
      }];

      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const output = await findTool(tools, "memory_status").handler({
        includeRecentTraces: true,
        includeRecentTrajectoryArtifacts: true,
      }, {
        sessionId: "session-memory-status-rich",
      });

      assert.match(output, /traceRecorderStoredRecords: 1/);
      assert.match(output, /## Recent Trace Records/);
      assert.match(output, /### trace-1/);
      assert.match(output, /promptNeed.allowCrossRepoFallback: true/);
      assert.match(output, /dropped: rank:cutoff — Older note/);
      assert.match(output, /## Recent Trajectory Artifacts/);
      assert.match(output, /\[traj-1\] kind=validation_failure/);
    } finally {
      cleanup();
    }
  });

  test("memory_status preserves improvement and trace-artifact summary lines", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });
    try {
      const runtime = buildRuntime(db, config);
      runtime.traceRecorder = {
        getStats() {
          return null;
        },
      };
      runtime.db.getStats = () => ({
        dbPath: "lore.db",
        schemaVersion: 7,
        semanticCount: 1,
        episodeCount: 2,
        semanticGlobalCount: 0,
        semanticTransferableCount: 0,
        semanticRepoCount: 1,
        semanticManualCount: 0,
        episodeTransferableCount: 0,
        episodeRepoCount: 2,
        episodeManualCount: 0,
        daySummaryCount: 1,
        overrideAuditCount: 0,
        semanticCanonicalCount: 0,
        semanticReinforcedCount: 0,
        assistantGoalCount: 0,
        recurringMistakeCount: 0,
        userIdentityCount: 0,
        workstreamOverlayCount: 0,
        domainCount: 0,
        observationCount: 0,
        directiveCount: 0,
        improvementCount: 4,
        improvementActiveCount: 2,
        improvementResolvedCount: 1,
        improvementSupersededCount: 1,
        improvementProposalCount: 2,
        draftProposalCount: 1,
        approvedProposalCount: 1,
        rejectedProposalCount: 0,
        supersededProposalCount: 0,
        maintenanceCompletedCount: 3,
        maintenanceNeedsAttentionCount: 1,
        maintenanceFailedCount: 0,
        maintenanceSkippedCount: 2,
        maintenanceTaskStateCount: 4,
        lastMaintenanceStatus: "completed",
        lastMaintenanceStartedAt: "2024-04-05T09:00:00.000Z",
        lastMaintenanceCompletedAt: "2024-04-05T09:02:00.000Z",
        trajectoryArtifactCount: 5,
        trajectoryReplayFailureCount: 2,
        trajectoryValidationMissCount: 1,
        trajectoryProposalFailureCount: 1,
        trajectoryLatencyOutlierCount: 1,
        retrievalTraceSampleCount: 3,
        retrievalTraceSampleRepositoryCount: 2,
        retrievalTraceSampleGlobalCount: 1,
        intentJournalCount: 6,
        intentRoutingCount: 2,
        intentRolloutCount: 1,
        intentReviewerCount: 1,
        intentFallbackCount: 1,
        intentSerendipityCount: 1,
        lastBackupPath: null,
        deferredPendingCount: 0,
        deferredRunningCount: 0,
        deferredFailedCount: 0,
        deferredCompletedCount: 0,
        backfillRunningCount: 0,
        backfillCompletedCount: 0,
        backfillFailedCount: 0,
        backfillDryRunCount: 0,
      });
      runtime.db.getActivityState = () => [];
      runtime.db.listRetrievalTraceSamples = () => [];
      runtime.db.listTrajectoryArtifacts = () => [];
      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const output = await findTool(tools, "memory_status").handler({}, {
        sessionId: "session-memory-status-summary",
      });

      assert.match(output, /improvementCount: 4/);
      assert.match(output, /approvedProposalCount: 1/);
      assert.match(output, /maintenanceSkippedCount: 2/);
      assert.match(output, /trajectoryArtifactCount: 5/);
      assert.match(output, /intentSerendipityCount: 1/);
      assert.match(output, /lastBackupPath: none/);
      assert.match(output, /configPath: /);
    } finally {
      cleanup();
    }
  });
});
