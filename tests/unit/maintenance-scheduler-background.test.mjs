import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runBackgroundMaintenanceSweep } from "../../lib/maintenance/maintenance-scheduler.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function buildRuntime(db, config) {
  return {
    db,
    config,
    repository: "fixture-repo",
    sessionStore: {
      getRecentSessions: () => [],
      getSessionArtifacts: () => null,
      getWorkspaceMetadata: () => null,
    },
  };
}

const DUE_OVERRIDES = {
  enabled: true,
  maintenanceScheduler: {
    enabled: true,
    autoRunOnSessionStart: true,
  },
  deferredExtraction: {
    enabled: true,
    autoProcessOnSessionStart: true,
  },
};

describe("runBackgroundMaintenanceSweep", () => {
  test("does nothing when maintenanceScheduler is disabled (the default)", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb();
    try {
      const outcome = await runBackgroundMaintenanceSweep({ runtime: buildRuntime(db, config), repository: "fixture-repo" });
      assert.equal(outcome.attempted, false);
      assert.equal(outcome.locked, false);
      assert.equal(outcome.result, null);
      assert.equal(db.listMaintenanceRuns({ limit: 5 }).length, 0, "a disabled scheduler must never create a maintenance_run row");
    } finally {
      cleanup();
    }
  });

  test("does nothing when autoRunOnSessionStart is false", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        maintenanceScheduler: { enabled: true, autoRunOnSessionStart: false },
        deferredExtraction: { enabled: true, autoProcessOnSessionStart: true },
      },
    });
    try {
      const outcome = await runBackgroundMaintenanceSweep({ runtime: buildRuntime(db, config), repository: "fixture-repo" });
      assert.equal(outcome.attempted, false);
      assert.equal(outcome.locked, false);
    } finally {
      cleanup();
    }
  });

  test("does nothing when enabled but nothing is due (memoryHygiene off, deferredExtraction off)", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        maintenanceScheduler: { enabled: true, autoRunOnSessionStart: true },
      },
    });
    try {
      const outcome = await runBackgroundMaintenanceSweep({ runtime: buildRuntime(db, config), repository: "fixture-repo" });
      assert.equal(outcome.attempted, false);
      assert.equal(outcome.plan.selectedTasks.length, 0);
    } finally {
      cleanup();
    }
  });

  test("runs the bounded session-start sweep when enabled and due", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({ configOverrides: DUE_OVERRIDES });
    try {
      const outcome = await runBackgroundMaintenanceSweep({ runtime: buildRuntime(db, config), repository: "fixture-repo" });
      assert.equal(outcome.attempted, true);
      assert.equal(outcome.locked, false);
      assert.ok(outcome.result, "an attempted sweep must return the underlying runMaintenanceSweep result");
      assert.deepEqual(
        outcome.result.tasks.map((task) => task.taskName),
        ["deferredExtraction"],
        "session_start scope must stay bound to memoryHygiene/deferredExtraction only",
      );
      const taskStates = db.listMaintenanceTaskStates();
      const deferred = taskStates.find((row) => row.task_name === "deferredExtraction");
      assert.ok(deferred?.last_completed_at, "the task state should reflect a completed run");
      // The lock must be released once the sweep finishes so a later sweep can run.
      assert.equal(db.acquireMaintenanceLock({ scope: "background", ownerToken: "post-check" }), true);
    } finally {
      cleanup();
    }
  });

  test("two concurrent background sweeps against the same database: only one does the work", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({ configOverrides: DUE_OVERRIDES });
    try {
      const runtime = buildRuntime(db, config);
      const [first, second] = await Promise.all([
        runBackgroundMaintenanceSweep({ runtime, repository: "fixture-repo", ownerToken: "runner-a" }),
        runBackgroundMaintenanceSweep({ runtime, repository: "fixture-repo", ownerToken: "runner-b" }),
      ]);
      const attemptedCount = [first, second].filter((outcome) => outcome.attempted).length;
      const lockedCount = [first, second].filter((outcome) => outcome.locked).length;
      assert.equal(attemptedCount, 1, "exactly one concurrent sweep should have run the tasks");
      assert.equal(lockedCount, 1, "the other concurrent sweep should have observed the lock held");
      assert.equal(db.listMaintenanceRuns({ limit: 5 }).length, 1, "only one maintenance_run row should be created");
    } finally {
      cleanup();
    }
  });
});
