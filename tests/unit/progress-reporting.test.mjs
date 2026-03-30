import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildSessionStartBackfillPreview,
  buildSessionStartBackfillDecision,
  summarizeBackfillRunProgress,
} from "../../lib/backfill.mjs";
import { createMemoryTools } from "../../lib/memory-tools.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function findTool(tools, name) {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `expected ${name} tool`);
  return tool;
}

function buildRuntime(db, config, { sessionStore } = {}) {
  return {
    initialized: true,
    lastError: null,
    db,
    config,
    repository: "fixture-repo",
    sessionStore: sessionStore ?? {
      getRecentSessions: () => [],
      getSessionArtifacts: () => null,
      getWorkspaceMetadata: () => null,
    },
    metrics: {
      sessionStart: null,
      userPromptSubmitted: null,
    },
    traceRecorder: null,
  };
}

describe("phase-3 progress reporting surfaces", () => {
  test("session-start backfill decision prefers resuming an existing running run", () => {
    const decision = buildSessionStartBackfillDecision({
      preview: { candidates: [{ sessionId: "session-a" }] },
      latestRun: {
        id: "run-123",
        status: "running",
        total_candidates: 12,
      },
    });

    assert.deepStrictEqual(decision, {
      action: "resume",
      reason: "existing_run",
      candidateCount: 12,
      runId: "run-123",
    });
  });

  test("session-start backfill decision skips when preview has no candidates", () => {
    const decision = buildSessionStartBackfillDecision({
      preview: { candidates: [] },
      latestRun: null,
    });

    assert.deepStrictEqual(decision, {
      action: "skip",
      reason: "up_to_date",
      candidateCount: 0,
      runId: null,
    });
  });

  test("summarizeBackfillRunProgress reports completed terminal state accurately", () => {
    const progress = summarizeBackfillRunProgress({
      status: "completed",
      total_candidates: 8,
      processed_count: 8,
      created_episode_count: 6,
      refreshed_episode_count: 2,
      failed_count: 0,
      skipped_count: 0,
      batch_size: 4,
    });

    assert.deepStrictEqual(progress, {
      totalCount: 8,
      completedCount: 8,
      createdCount: 6,
      refreshedCount: 2,
      failedCount: 0,
      skippedCount: 0,
      pendingCount: 0,
      runningCount: 0,
      progressPercent: 100,
      currentPhase: "complete",
    });
  });

  test("session-start backfill preview bounds candidates while scanning older sessions", () => {
    const preview = buildSessionStartBackfillPreview({
      db: {
        hasEpisodeDigest(sessionId) {
          return ["session-a", "session-b", "session-c"].includes(sessionId);
        },
      },
      sessionStore: {
        getRecentSessionsWindow({ offset }) {
          if (offset === 0) {
            return [
              { id: "session-a", repository: "fixture-repo", updated_at: null, summary: "a" },
              { id: "session-b", repository: "fixture-repo", updated_at: null, summary: "b" },
              { id: "session-c", repository: "fixture-repo", updated_at: null, summary: "c" },
              { id: "session-d", repository: "fixture-repo", updated_at: null, summary: "d" },
            ];
          }
          if (offset === 4) {
            return [
              { id: "session-e", repository: "fixture-repo", updated_at: null, summary: "e" },
              { id: "session-f", repository: "fixture-repo", updated_at: null, summary: "f" },
            ];
          }
          return [];
        },
      },
      repository: "fixture-repo",
      includeOtherRepositories: false,
      maxCandidates: 2,
      refreshExisting: false,
      scanWindowSize: 4,
    });

    assert.strictEqual(preview.inspected, 6);
    assert.strictEqual(preview.skippedExisting, 3);
    assert.deepStrictEqual(
      preview.candidates.map((candidate) => candidate.sessionId),
      ["session-d", "session-e"],
    );
  });

  test("memory_backfill controlled preview reports stable progress totals and phase", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });
    try {
      const runtime = buildRuntime(db, config, {
        sessionStore: {
          getRecentSessions: () => [
            { id: "session-a", repository: "fixture-repo", updated_at: null, summary: "alpha" },
            { id: "session-b", repository: "fixture-repo", updated_at: null, summary: "beta" },
          ],
          getSessionArtifacts: () => null,
          getWorkspaceMetadata: () => null,
        },
      });
      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const output = await findTool(tools, "memory_backfill").handler({
        mode: "controlled",
        action: "preview",
        limit: 5,
      }, {
        sessionId: "session-progress-preview",
      });

      assert.match(output, /progressTotalCount: 2/);
      assert.match(output, /progressCompletedCount: 0/);
      assert.match(output, /progressPendingCount: 2/);
      assert.match(output, /progressPercent: 0/);
      assert.match(output, /currentPhase: planning/);
    } finally {
      cleanup();
    }
  });

  test("memory_backfill controlled status reports running counts and current phase", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });
    try {
      db.createBackfillRun({
        strategy: "session_refresh",
        dryRun: false,
        repository: "fixture-repo",
        includeOtherRepositories: false,
        refreshExisting: true,
        batchSize: 5,
        totalCandidates: 2,
        snapshotPath: null,
        metadata: {},
      });

      const runtime = buildRuntime(db, config);
      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const output = await findTool(tools, "memory_backfill").handler({
        mode: "controlled",
        action: "status",
      }, {
        sessionId: "session-progress-status",
      });

      assert.match(output, /progressTotalCount: 2/);
      assert.match(output, /progressCompletedCount: 0/);
      assert.match(output, /progressRunningCount: 2/);
      assert.match(output, /currentPhase: processing/);
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
      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const output = await findTool(tools, "memory_status").handler({}, {
        sessionId: "session-memory-status",
      });

      assert.match(output, /deferredActionableCount: 1/);
      assert.match(output, /deferredCurrentPhase: queued/);
      assert.match(output, /backfillCurrentPhase: idle/);
    } finally {
      cleanup();
    }
  });
});
