import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { maybeSpawnBackgroundMaintenance } from "../../lib/clients/cli-runtime.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

const RUN_MAINTENANCE_SCRIPT_PATH = fileURLToPath(new URL("../../scripts/run-maintenance.mjs", import.meta.url));

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

function buildRuntime(db, config, repository = "fixture-repo") {
  return { db, config, repository };
}

function fakeSpawner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { unref: () => {}, on: () => {} };
  };
}

describe("maybeSpawnBackgroundMaintenance (native CLI hook background trigger)", () => {
  test("spawns a detached, unref'd background sweep when enabled and due on SessionStart", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({ configOverrides: DUE_OVERRIDES });
    try {
      const calls = [];
      const outcome = maybeSpawnBackgroundMaintenance({
        runtime: buildRuntime(db, config),
        client: "claude",
        event: "SessionStart",
        payload: {},
        spawnImpl: fakeSpawner(calls),
      });
      assert.equal(outcome.spawned, true);
      assert.equal(calls.length, 1, "must spawn exactly once");
      const [call] = calls;
      assert.equal(call.command, process.execPath);
      assert.equal(call.args[0], RUN_MAINTENANCE_SCRIPT_PATH);
      assert.ok(call.args.includes("--background"));
      assert.ok(call.args.includes("--repository"));
      assert.ok(call.args.includes("fixture-repo"));
      assert.ok(call.args.includes("--config"));
      assert.equal(call.args[call.args.indexOf("--config") + 1], config.configPath);
      assert.equal(call.options.detached, true);
      assert.equal(call.options.stdio, "ignore");
    } finally {
      cleanup();
    }
  });

  test("does not spawn when maintenanceScheduler is disabled (the default)", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb();
    try {
      const calls = [];
      const outcome = maybeSpawnBackgroundMaintenance({
        runtime: buildRuntime(db, config),
        client: "claude",
        event: "SessionStart",
        payload: {},
        spawnImpl: fakeSpawner(calls),
      });
      assert.equal(outcome.spawned, false);
      assert.equal(calls.length, 0);
    } finally {
      cleanup();
    }
  });

  test("does not spawn when nothing is due even though the scheduler is enabled", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        maintenanceScheduler: { enabled: true, autoRunOnSessionStart: true },
      },
    });
    try {
      const calls = [];
      const outcome = maybeSpawnBackgroundMaintenance({
        runtime: buildRuntime(db, config),
        client: "codex",
        event: "SessionStart",
        payload: {},
        spawnImpl: fakeSpawner(calls),
      });
      assert.equal(outcome.spawned, false);
      assert.equal(calls.length, 0);
    } finally {
      cleanup();
    }
  });

  test("ignores non-session-start events even when due", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({ configOverrides: DUE_OVERRIDES });
    try {
      for (const event of ["UserPromptSubmit", "Stop", "SessionEnd", "PreCompact", "PostToolUse"]) {
        const calls = [];
        const outcome = maybeSpawnBackgroundMaintenance({
          runtime: buildRuntime(db, config),
          client: "claude",
          event,
          payload: {},
          spawnImpl: fakeSpawner(calls),
        });
        assert.equal(outcome.spawned, false, event);
        assert.equal(calls.length, 0, event);
      }
    } finally {
      cleanup();
    }
  });

  test("Antigravity: only the first PreInvocation (invocationNum 0) triggers a spawn", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({ configOverrides: DUE_OVERRIDES });
    try {
      const laterCalls = [];
      const later = maybeSpawnBackgroundMaintenance({
        runtime: buildRuntime(db, config),
        client: "antigravity",
        event: "PreInvocation",
        payload: { invocationNum: 1 },
        spawnImpl: fakeSpawner(laterCalls),
      });
      assert.equal(later.spawned, false);
      assert.equal(laterCalls.length, 0);

      const firstCalls = [];
      const first = maybeSpawnBackgroundMaintenance({
        runtime: buildRuntime(db, config),
        client: "antigravity",
        event: "PreInvocation",
        payload: { invocationNum: 0 },
        spawnImpl: fakeSpawner(firstCalls),
      });
      assert.equal(first.spawned, true);
      assert.equal(firstCalls.length, 1);
    } finally {
      cleanup();
    }
  });

  test("a spawn failure is swallowed and reported, never thrown", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({ configOverrides: DUE_OVERRIDES });
    try {
      const outcome = maybeSpawnBackgroundMaintenance({
        runtime: buildRuntime(db, config),
        client: "claude",
        event: "SessionStart",
        payload: {},
        spawnImpl: () => {
          throw new Error("boom");
        },
      });
      assert.equal(outcome.spawned, false);
      assert.equal(outcome.reason, "spawn_failed");
    } finally {
      cleanup();
    }
  });
});
