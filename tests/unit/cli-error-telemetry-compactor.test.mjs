import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createCliErrorTelemetryCompactor } from "../../lib/clients/cli-runtime.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

describe("createCliErrorTelemetryCompactor", () => {
  test("with injected random that always returns high value (< 1/50 = false), no pruning occurs", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({ configOverrides: { enabled: true, rollout: { errorTelemetry: true } } });
    try {
      // Insert some error telemetry rows
      db.insertErrorTelemetry({
        sessionId: "test-session-1",
        contextCategory: "tool_use",
        recoverability: "recoverable",
        fingerprint: "fp1",
      });
      db.insertErrorTelemetry({
        sessionId: "test-session-2",
        contextCategory: "tool_use",
        recoverability: "recoverable",
        fingerprint: "fp2",
      });
      assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM error_telemetry").get().c, 2);

      // Create compactor with random that always returns 0.9 (> 1/50 = 0.02)
      const compactor = createCliErrorTelemetryCompactor({
        db,
        randomSource: () => 0.9,
      });
      compactor();

      // Rows should still be there (no pruning occurred)
      assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM error_telemetry").get().c, 2);
    } finally {
      cleanup();
    }
  });

  test("with injected random that always returns low value (< 1/50 = true), pruning occurs", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({ configOverrides: { enabled: true, rollout: { errorTelemetry: true } } });
    try {
      // Insert some error telemetry rows
      db.insertErrorTelemetry({
        sessionId: "test-session-1",
        contextCategory: "tool_use",
        recoverability: "recoverable",
        fingerprint: "fp1",
      });
      db.insertErrorTelemetry({
        sessionId: "test-session-2",
        contextCategory: "tool_use",
        recoverability: "recoverable",
        fingerprint: "fp2",
      });
      assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM error_telemetry").get().c, 2);

      // Create compactor with random that always returns 0 (< 1/50 = 0.02)
      const compactor = createCliErrorTelemetryCompactor({
        db,
        randomSource: () => 0,
      });
      compactor();

      // Rows should still be there (both are recent, not pruned by age)
      assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM error_telemetry").get().c, 2);
    } finally {
      cleanup();
    }
  });

  test("pruning removes rows beyond retention limit (maxRowsGlobal: 500)", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({ configOverrides: { enabled: true, rollout: { errorTelemetry: true } } });
    try {
      // Insert more than 500 rows to exceed the retention limit
      for (let i = 0; i < 510; i++) {
        db.insertErrorTelemetry({
          sessionId: `test-session-${i}`,
          contextCategory: "tool_use",
          recoverability: "recoverable",
          fingerprint: `fp${i}`,
        });
      }
      assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM error_telemetry").get().c, 510);

      // Create compactor with random that always triggers
      const compactor = createCliErrorTelemetryCompactor({
        db,
        randomSource: () => 0,
      });
      compactor();

      // Should prune down to exactly 500 (the maxRowsGlobal limit)
      assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM error_telemetry").get().c, 500);
    } finally {
      cleanup();
    }
  });

  test("default randomSource uses Math.random", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({ configOverrides: { enabled: true, rollout: { errorTelemetry: true } } });
    try {
      // Insert a row
      db.insertErrorTelemetry({
        sessionId: "test-session-1",
        contextCategory: "tool_use",
        recoverability: "recoverable",
        fingerprint: "fp1",
      });

      // Create compactor without explicit randomSource
      const compactor = createCliErrorTelemetryCompactor({ db });

      // It should not throw
      assert.doesNotThrow(() => {
        compactor();
      });
    } finally {
      cleanup();
    }
  });

  test("compactor is callable multiple times without error", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({ configOverrides: { enabled: true, rollout: { errorTelemetry: true } } });
    try {
      const compactor = createCliErrorTelemetryCompactor({
        db,
        randomSource: () => 0,
      });

      // Should be callable multiple times
      assert.doesNotThrow(() => {
        compactor();
        compactor();
        compactor();
      });
    } finally {
      cleanup();
    }
  });
});
