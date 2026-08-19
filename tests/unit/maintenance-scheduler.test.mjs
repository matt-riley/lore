import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildMaintenancePlan,
  runMaintenanceSweep,
} from "../../lib/maintenance-scheduler.mjs";
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

  test("reclaims stale maintenance runs and task state before planning", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        maintenanceScheduler: {
          enabled: true,
          staleRunAfterMinutes: 30,
        },
      },
    });
    try {
      const runId = db.createMaintenanceRun({
        trigger: "session_start",
        repository: "fixture-repo",
        plannedTasks: ["deferredExtraction"],
      });
      db.recordMaintenanceTaskStart({
        taskName: "deferredExtraction",
        trigger: "session_start",
        repository: "fixture-repo",
        startedAt: "2024-01-01T00:00:00.000Z",
      });
      db.db.prepare(`
        UPDATE maintenance_run
        SET started_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        "2024-01-01T00:00:00.000Z",
        "2024-01-01T00:00:00.000Z",
        runId,
      );

      buildMaintenancePlan({
        runtime: buildRuntime(db, config),
        repository: "fixture-repo",
        trigger: "status",
        recoverStaleWork: true,
      });

      const run = db.db.prepare(`
        SELECT status, failed_count, completed_at, summary_json
        FROM maintenance_run
        WHERE id = ?
      `).get(runId);
      assert.equal(run.status, "failed");
      assert.equal(run.failed_count, 1);
      assert.ok(run.completed_at);
      assert.match(run.summary_json, /stale maintenance run reclaimed/);

      const taskState = db.db.prepare(`
        SELECT last_status, total_failures, last_summary_json
        FROM maintenance_task_state
        WHERE task_name = 'deferredExtraction'
      `).get();
      assert.equal(taskState.last_status, "failed");
      assert.equal(taskState.total_failures, 1);
      assert.match(taskState.last_summary_json, /stale maintenance run reclaimed/);

      // A worker that outlives the recovery must not resurrect its run/task.
      db.completeMaintenanceRun({
        runId,
        status: "completed",
        completedAt: "2024-01-01T00:01:00.000Z",
      });
      db.recordMaintenanceTaskResult({
        taskName: "deferredExtraction",
        status: "completed",
        trigger: "session_start",
        repository: "fixture-repo",
        startedAt: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-01T00:01:00.000Z",
      });
      const recoveredRun = db.db.prepare(`
        SELECT status
        FROM maintenance_run
        WHERE id = ?
      `).get(runId);
      const recoveredTaskState = db.db.prepare(`
        SELECT last_status
        FROM maintenance_task_state
        WHERE task_name = 'deferredExtraction'
      `).get();
      assert.equal(recoveredRun.status, "failed");
      assert.equal(recoveredTaskState.last_status, "failed");
    } finally {
      cleanup();
    }
  });

  test("session-start memory hygiene runs in shadow mode and reports candidates without mutation", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        maintenanceScheduler: {
          enabled: true,
          autoRunOnSessionStart: true,
          memoryHygiene: {
            mode: "shadow",
            maxItems: 10,
            includeGlobal: true,
          },
          tasks: {
            deferredExtraction: false,
            memoryHygiene: true,
          },
        },
      },
    });
    try {
      const memoryId = db.insertSemanticMemory({
        id: "maintenance-hygiene-memory",
        type: "open_loop",
        content: "Promote commit abc1234 into main.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 0.9,
        tags: ["open-loop"],
      });
      const runtime = buildRuntime(db, config);
      runtime.memoryHygieneIsCommitAncestor = async () => true;

      const result = await runMaintenanceSweep({
        runtime,
        repository: "fixture-repo",
        trigger: "session_start",
      });

      assert.equal(result.status, "completed");
      assert.equal(result.taskCount, 1);
      assert.equal(result.tasks[0].taskName, "memoryHygiene");
      assert.equal(result.tasks[0].summary.candidateCount, 1);
      assert.equal(result.tasks[0].summary.resolvedCount, 0);
      const row = db.db.prepare(`
        SELECT superseded_by
        FROM semantic_memory
        WHERE id = ?
      `).get(memoryId);
      assert.equal(row.superseded_by, null);
      const summaryArtifacts = db.listTrajectoryArtifacts({
        kind: "memory_hygiene_run",
        repository: "fixture-repo",
        limit: 5,
      });
      assert.equal(summaryArtifacts.length, 1);
      assert.equal(summaryArtifacts[0].context.candidateCount, 1);
    } finally {
      cleanup();
    }
  });
});
