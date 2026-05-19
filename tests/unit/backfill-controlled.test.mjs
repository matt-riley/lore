import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  restoreControlledBackfillRun,
  startControlledBackfillRun,
} from "../../lib/backfill.mjs";
import { createMemoryTools } from "../../lib/memory-tools.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";
import { findTool, buildBackfillRuntime as buildRuntime } from "../helpers/tool-helpers.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

describe("backfill controlled operations", { concurrency: false }, () => {
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

  test("memory_backfill controlled preview defaults to the public 20-session cap", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });
    try {
      const runtime = buildRuntime(db, config, {
        sessionStore: {
          getRecentSessions: ({ limit }) => Array.from({ length: 25 }, (_, index) => ({
            id: `session-${index + 1}`,
            repository: "fixture-repo",
            updated_at: null,
            summary: `summary-${index + 1}`,
          })).slice(0, limit),
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
      }, {
        sessionId: "session-progress-preview-default-cap",
      });

      assert.match(output, /inspected: 20/);
      assert.match(output, /candidateCount: 20/);
      assert.match(output, /progressTotalCount: 20/);
    } finally {
      cleanup();
    }
  });

  test("memory_backfill controlled preview accepts explicit limits above 20 up to 100", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });
    try {
      const runtime = buildRuntime(db, config, {
        sessionStore: {
          getRecentSessions: ({ limit }) => Array.from({ length: 120 }, (_, index) => ({
            id: `session-${index + 1}`,
            repository: "fixture-repo",
            updated_at: null,
            summary: `summary-${index + 1}`,
          })).slice(0, limit),
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
        limit: 80,
      }, {
        sessionId: "session-progress-preview-expanded-cap",
      });

      assert.match(output, /inspected: 80/);
      assert.match(output, /candidateCount: 80/);
      assert.match(output, /progressTotalCount: 80/);
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
      const runId = db.createBackfillRun({
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
        runId,
      }, {
        sessionId: "session-progress-status",
      });

      assert.match(output, /progressTotalCount: 2/);
      assert.match(output, /progressCompletedCount: 0/);
      assert.match(output, /progressRunningCount: 2/);
      assert.match(output, /currentPhase: processing/);
      assert.match(output, /snapshotPath: none/);
    } finally {
      cleanup();
    }
  });

  test("controlled backfill can skip snapshot creation when snapshot policy is never", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });
    try {
      const result = startControlledBackfillRun({
        db,
        sessionStore: {
          getRecentSessions: () => [
            { id: "session-a", repository: "fixture-repo", updated_at: null, summary: "alpha" },
          ],
          getSessionArtifacts: () => ({ turns: [], workspace: null }),
          getWorkspaceMetadata: () => null,
        },
        repository: "fixture-repo",
        includeOtherRepositories: false,
        limit: 5,
        refreshExisting: false,
        batchSize: 5,
        snapshotPolicy: "never",
      });

      assert.strictEqual(result.snapshotPath, null);
      assert.strictEqual(result.run.snapshot_path, null);
    } finally {
      cleanup();
    }
  });

  test("controlled backfill rejects invalid snapshot policies", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });
    try {
      assert.throws(
        () => startControlledBackfillRun({
          db,
          sessionStore: {
            getRecentSessions: () => [
              { id: "session-a", repository: "fixture-repo", updated_at: null, summary: "alpha" },
            ],
            getSessionArtifacts: () => ({ turns: [], workspace: null }),
            getWorkspaceMetadata: () => null,
          },
          repository: "fixture-repo",
          includeOtherRepositories: false,
          limit: 5,
          refreshExisting: false,
          batchSize: 5,
          snapshotPolicy: "typo",
        }),
        /invalid controlled backfill snapshot policy/,
      );
    } finally {
      cleanup();
    }
  });

  test("manual controlled memory_backfill start still creates a snapshot path", { skip: SKIP_NO_FTS5 }, async () => {
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
          ],
          getSessionArtifacts: () => ({ turns: [], workspace: null }),
          getWorkspaceMetadata: () => null,
        },
      });
      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const output = await findTool(tools, "memory_backfill").handler({
        mode: "controlled",
        action: "start",
        limit: 5,
        batchSize: 5,
        refreshExisting: false,
      }, {
        sessionId: "session-controlled-start",
      });

      assert.match(output, /snapshotPath: .*lore-.*\.db/);
    } finally {
      cleanup();
    }
  });

  test("restoreControlledBackfillRun still fails clearly for runs without snapshots", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });
    try {
      const runId = db.createBackfillRun({
        strategy: "session_refresh",
        dryRun: false,
        repository: "fixture-repo",
        includeOtherRepositories: false,
        refreshExisting: false,
        batchSize: 5,
        totalCandidates: 1,
        snapshotPath: null,
        metadata: {},
      });

      assert.throws(
        () => restoreControlledBackfillRun({ db, runId }),
        /does not have a snapshot path/,
      );
    } finally {
      cleanup();
    }
  });
});
