import assert from "node:assert/strict";
import { describe, test } from "node:test";

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
