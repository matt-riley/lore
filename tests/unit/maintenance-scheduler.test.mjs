import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runMaintenanceSweep } from "../../lib/maintenance-scheduler.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function buildRuntime(db, config, { traceRecorder = null } = {}) {
  return {
    db,
    config,
    repository: "fixture-repo",
    sessionStore: {
      getRecentSessions: () => [],
      getSessionArtifacts: () => null,
      getWorkspaceMetadata: () => null,
    },
    traceRecorder,
  };
}

describe("maintenance scheduler task execution", () => {
  test("runMaintenanceSweep uses the default trace compaction summary when compaction is unavailable", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        maintenanceScheduler: {
          enabled: true,
          tasks: {
            traceCompaction: true,
          },
        },
      },
    });
    try {
      const result = await runMaintenanceSweep({
        runtime: buildRuntime(db, config, {
          traceRecorder: {
            isEnabled: () => true,
          },
        }),
        repository: "fixture-repo",
        requestedTasks: ["traceCompaction"],
        force: true,
      });

      assert.equal(result.status, "completed");
      assert.equal(result.taskCount, 1);
      assert.deepStrictEqual(result.tasks[0], {
        taskName: "traceCompaction",
        label: "Trace Compaction",
        status: "completed",
        durationMs: result.tasks[0].durationMs,
        summary: {
          storedBefore: 0,
          storedAfter: 0,
          expiredRemoved: 0,
          totalRecorded: 0,
        },
      });
    } finally {
      cleanup();
    }
  });

  test("runMaintenanceSweep marks backlog review completed when nothing needs attention", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        maintenanceScheduler: {
          enabled: true,
          tasks: {
            backlogReview: true,
          },
        },
        rollout: {
          evolutionLedger: true,
          proposalGeneration: false,
          generatedArtifactIntegrity: false,
        },
      },
    });
    try {
      const result = await runMaintenanceSweep({
        runtime: buildRuntime(db, config),
        repository: "fixture-repo",
        requestedTasks: ["backlogReview"],
        force: true,
      });

      assert.equal(result.status, "completed");
      assert.equal(result.taskCount, 1);
      assert.equal(result.tasks[0].status, "completed");
      assert.equal(result.tasks[0].summary.staleCount, 0);
      assert.equal(result.tasks[0].summary.proposalGeneration.enabled, false);
      assert.equal(result.tasks[0].summary.integrity.enabled, false);
    } finally {
      cleanup();
    }
  });

  test("runMaintenanceSweep marks backlog review needs_attention when stale artifacts exist", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        maintenanceScheduler: {
          enabled: true,
          tasks: {
            backlogReview: true,
          },
        },
        rollout: {
          evolutionLedger: true,
          proposalGeneration: false,
          generatedArtifactIntegrity: false,
        },
      },
    });
    try {
      const artifactId = db.upsertImprovementArtifact({
        sourceCaseId: "stale-backlog-artifact",
        sourceKind: "signal",
        title: "Stale backlog artifact",
        summary: "Exercise the backlog review attention branch.",
      });
      db.db.prepare(`
        UPDATE improvement_backlog
        SET updated_at = ?
        WHERE id = ?
      `).run("2020-01-01T00:00:00.000Z", artifactId);

      const result = await runMaintenanceSweep({
        runtime: buildRuntime(db, config),
        repository: "fixture-repo",
        requestedTasks: ["backlogReview"],
        force: true,
      });

      assert.equal(result.status, "needs_attention");
      assert.equal(result.taskCount, 1);
      assert.equal(result.tasks[0].status, "needs_attention");
      assert.equal(result.tasks[0].summary.staleCount, 1);
      assert.deepStrictEqual(result.tasks[0].summary.staleArtifacts, [
        {
          id: artifactId,
          title: "Stale backlog artifact",
          sourceKind: "signal",
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ]);
      assert.equal(result.tasks[0].summary.proposalGeneration.generatedCount, 0);
      assert.equal(result.tasks[0].summary.integrity.issueCount, 0);
    } finally {
      cleanup();
    }
  });
});
