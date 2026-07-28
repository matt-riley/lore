/**
 * tests/unit/extension-shutdown.test.mjs
 *
 * Tests for the background-work tracking and bounded shutdown helpers defined
 * in extension.mjs.  Functions are loaded via the source-parser approach used
 * by the other extension hook tests so they can be tested without importing
 * the whole extension entrypoint (which depends on @github/copilot-sdk).
 *
 * Covers:
 *   - trackBackgroundWork registers the promise and removes it on settlement
 *   - spawnTrackedMicrotask registers work and short-circuits when shutting down
 *   - spawnTrackedDeferredTask registers work and short-circuits when shutting down
 *   - shutdownRuntime: drains pending work then calls db.close() exactly once
 *   - shutdownRuntime: idempotent — second call is a no-op
 *   - shutdownRuntime: respects gracePeriodMs when work is slow
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { makeSourceExtractor } from "../helpers/source-parser.mjs";

const EXTENSION_SOURCE = readFileSync(new URL("../../extension.mjs", import.meta.url), "utf8");
const extractFunctionSource = makeSourceExtractor(EXTENSION_SOURCE);

function loadFunction(name, dependencies = {}) {
  const functionSource = extractFunctionSource(name);
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; ${functionSource}; return ${name};`,
  )(...Object.values(dependencies));
}

function loadFunctions(names, dependencies = {}) {
  const functionSources = names.map((name) => extractFunctionSource(name)).join("\n\n");
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; ${functionSources}; return { ${names.join(", ")} };`,
  )(...Object.values(dependencies));
}

// ---------------------------------------------------------------------------
// trackBackgroundWork
// ---------------------------------------------------------------------------

describe("trackBackgroundWork", () => {
  test("adds promise to pendingWork and removes it on resolution", async () => {
    const pendingWork = new Set();
    const runtime = { pendingWork };

    const trackBackgroundWork = loadFunction("trackBackgroundWork", { runtime });

    let resolve;
    const p = new Promise((res) => { resolve = res; });

    trackBackgroundWork(p);
    assert.equal(pendingWork.size, 1, "promise should be in pendingWork while pending");

    resolve();
    await p;
    // Give the finally handler a tick to run
    await Promise.resolve();

    assert.equal(pendingWork.size, 0, "promise should be removed after resolution");
  });

  test("removes promise from pendingWork on rejection", async () => {
    const pendingWork = new Set();
    const runtime = { pendingWork };

    const trackBackgroundWork = loadFunction("trackBackgroundWork", { runtime });

    const p = Promise.reject(new Error("test rejection")).catch(() => {});
    trackBackgroundWork(p);

    await p;
    await Promise.resolve();

    assert.equal(pendingWork.size, 0, "rejected promise should also be removed");
  });
});

// ---------------------------------------------------------------------------
// spawnTrackedMicrotask
// ---------------------------------------------------------------------------

describe("spawnTrackedMicrotask", () => {
  test("spawns and tracks a microtask promise when not shutting down", async () => {
    const pendingWork = new Set();
    const runtime = { pendingWork, shuttingDown: false };

    const { spawnTrackedMicrotask, trackBackgroundWork } = loadFunctions(
      ["spawnTrackedMicrotask", "trackBackgroundWork"],
      { runtime },
    );

    let resolved = false;
    spawnTrackedMicrotask(async () => {
      resolved = true;
    });

    // pendingWork should have one entry immediately
    assert.equal(pendingWork.size, 1, "microtask should be in pendingWork immediately");

    // Let it run
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(resolved, true, "fn should have run");
    assert.equal(pendingWork.size, 0, "pendingWork should be empty after completion");
  });

  test("does not spawn work when shuttingDown is true", async () => {
    const pendingWork = new Set();
    const runtime = { pendingWork, shuttingDown: true };

    const { spawnTrackedMicrotask, trackBackgroundWork } = loadFunctions(
      ["spawnTrackedMicrotask", "trackBackgroundWork"],
      { runtime },
    );

    let ran = false;
    spawnTrackedMicrotask(async () => { ran = true; });

    await new Promise((res) => setTimeout(res, 10));
    assert.equal(ran, false, "fn must not run when shutting down");
    assert.equal(pendingWork.size, 0, "pendingWork must remain empty");
  });
});

// ---------------------------------------------------------------------------
// spawnTrackedDeferredTask
// ---------------------------------------------------------------------------

describe("spawnTrackedDeferredTask", () => {
  test("spawns and tracks a deferred task promise when not shutting down", async () => {
    const pendingWork = new Set();
    const runtime = { pendingWork, shuttingDown: false };

    const { spawnTrackedDeferredTask, trackBackgroundWork } = loadFunctions(
      ["spawnTrackedDeferredTask", "trackBackgroundWork"],
      { runtime },
    );

    let ran = false;
    spawnTrackedDeferredTask(async () => { ran = true; });

    // promise is tracked before the task runs
    assert.equal(pendingWork.size, 1, "deferred task should be in pendingWork immediately");

    await new Promise((res) => setTimeout(res, 20));
    assert.equal(ran, true, "fn should have run after setTimeout");
    assert.equal(pendingWork.size, 0, "pendingWork should be empty after completion");
  });

  test("does not spawn work when shuttingDown is true", async () => {
    const pendingWork = new Set();
    const runtime = { pendingWork, shuttingDown: true };

    const { spawnTrackedDeferredTask, trackBackgroundWork } = loadFunctions(
      ["spawnTrackedDeferredTask", "trackBackgroundWork"],
      { runtime },
    );

    let ran = false;
    spawnTrackedDeferredTask(async () => { ran = true; });

    await new Promise((res) => setTimeout(res, 20));
    assert.equal(ran, false, "fn must not run when shutting down");
    assert.equal(pendingWork.size, 0, "pendingWork must remain empty");
  });
});

// ---------------------------------------------------------------------------
// shutdownRuntime
// ---------------------------------------------------------------------------

describe("shutdownRuntime", () => {
  test("sets shuttingDown, drains pending work, and calls db.close() once", async () => {
    const closeCalls = [];
    let nulledDb = false;
    const runtime = {
      pendingWork: new Set(),
      shuttingDown: false,
      db: {
        close() { closeCalls.push("close"); },
      },
    };

    const delays = [];
    const { shutdownRuntime, trackBackgroundWork } = loadFunctions(
      ["shutdownRuntime", "trackBackgroundWork"],
      {
        runtime,
        async delay(ms) { delays.push(ms); },
        Promise,
      },
    );

    // Add a fast-settling background job
    const p = Promise.resolve();
    trackBackgroundWork(p);
    await p;
    await Promise.resolve();

    const session = { async log() {} };
    await shutdownRuntime(session, 4000);

    assert.equal(runtime.shuttingDown, true, "shuttingDown should be true after shutdown");
    assert.equal(closeCalls.length, 1, "db.close() should be called exactly once");
    assert.equal(runtime.db, null, "runtime.db should be nulled after shutdown");
  });

  test("does nothing on second call (idempotent)", async () => {
    const closeCalls = [];
    const runtime = {
      pendingWork: new Set(),
      shuttingDown: false,
      db: {
        close() { closeCalls.push("close"); },
      },
    };

    const { shutdownRuntime, trackBackgroundWork } = loadFunctions(
      ["shutdownRuntime", "trackBackgroundWork"],
      {
        runtime,
        async delay() {},
        Promise,
      },
    );

    const session = { async log() {} };
    await shutdownRuntime(session, 100);
    await shutdownRuntime(session, 100);

    assert.equal(closeCalls.length, 1, "close should only be called once even when shutdown called twice");
  });

  test("resolves within gracePeriodMs when pending work is slow", async () => {
    const closeCalls = [];
    const runtime = {
      pendingWork: new Set(),
      shuttingDown: false,
      db: {
        close() { closeCalls.push("close"); },
      },
    };

    const { shutdownRuntime, trackBackgroundWork } = loadFunctions(
      ["shutdownRuntime", "trackBackgroundWork"],
      {
        runtime,
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        Promise,
      },
    );

    // Add a work item that never settles within the grace period
    let resolveWork;
    const slowWork = new Promise((resolve) => { resolveWork = resolve; });
    trackBackgroundWork(slowWork);

    const start = Date.now();
    const session = { async log() {} };
    // Very short grace period — should bail out quickly
    await shutdownRuntime(session, 50);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 500, `shutdown should complete within 500ms, took ${elapsed}ms`);
    assert.equal(closeCalls.length, 1, "close should still be called after grace period");
    resolveWork(); // cleanup
  });

  test("calls db.close() even when db is null (no-op)", async () => {
    const runtime = {
      pendingWork: new Set(),
      shuttingDown: false,
      db: null,
    };

    const { shutdownRuntime } = loadFunctions(
      ["shutdownRuntime", "trackBackgroundWork"],
      {
        runtime,
        async delay() {},
        Promise,
      },
    );

    const session = { async log() {} };
    // Should not throw when db is null
    await assert.doesNotReject(() => shutdownRuntime(session, 100));
  });
});

// ---------------------------------------------------------------------------
// handleSessionEndHook — shutdown runs even for empty/no-artifact sessions
// ---------------------------------------------------------------------------

describe("handleSessionEndHook empty-session shutdown", () => {
  test("drains pending background work and closes the DB once when no session artifacts exist", async () => {
    const closeCalls = [];
    const runtime = {
      pendingWork: new Set(),
      shuttingDown: false,
      initialized: true,
      lastError: null,
      config: {},
      db: {
        close() { closeCalls.push("close"); },
      },
    };

    // Register a fast background job before session end to confirm drain
    let workSettled = false;
    const work = new Promise((res) => setTimeout(() => { workSettled = true; res(); }, 5));
    runtime.pendingWork.add(work);
    work.then(() => runtime.pendingWork.delete(work));

    const { handleSessionEndHook, shutdownRuntime, trackBackgroundWork } = loadFunctions(
      ["handleSessionEndHook", "shutdownRuntime", "trackBackgroundWork"],
      {
        runtime,
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        Promise,
        getContext: async () => ({ runtime, workspace: "/fake/ws", repository: "owner/repo" }),
        hooksEnabled: () => true,
        readSessionEndExtraction: () => null,
        applySessionExtraction: () => { throw new Error("must not be called for empty session"); },
        maybeEnqueueDeferredSessionExtraction: () => { throw new Error("must not be called for empty session"); },
      },
    );

    const session = { async log() {} };
    await handleSessionEndHook({
      session,
      invocation: { sessionId: "session-empty-regression" },
      input: { cwd: "/fake/cwd", reason: "normal" },
    });

    assert.equal(closeCalls.length, 1, "db.close() must be called exactly once even when no artifacts exist");
    assert.equal(runtime.db, null, "runtime.db must be nulled after shutdown");
    assert.equal(runtime.shuttingDown, true, "runtime.shuttingDown must be true after shutdown");
    assert.equal(workSettled, true, "pending background work must have settled before shutdown closed the DB");
    assert.equal(runtime.pendingWork.size, 0, "pendingWork must be empty after drain");
  });
});

// ---------------------------------------------------------------------------
// persistTraceSuccess catch → warning log
// ---------------------------------------------------------------------------

describe("persistTraceSuccess trace-persistence warning", () => {
  test("logs warning via session when trace persistence throws", async () => {
    const warnings = [];
    const fakeSession = {
      async log(message, options) {
        if (options?.level === "warning") {
          warnings.push(message);
        }
      },
    };

    const pendingWork = new Set();
    const runtime = { pendingWork, shuttingDown: false };

    const { persistTraceSuccess, spawnTrackedMicrotask, trackBackgroundWork } = loadFunctions(
      [
        "resolveTraceSuccessRecord",
        "buildTraceSuccessUpdates",
        "buildDurableTraceSampleRecordFields",
        "buildDurableTraceSampleEvidenceFields",
        "buildDurableTraceSamplePayload",
        "persistTraceContextInjectionUpdates",
        "maybePruneDurableTraceSamples",
        "persistDurableTraceSample",
        "writeActivitySuccessUpdates",
        "persistTraceSuccess",
        "spawnTrackedMicrotask",
        "trackBackgroundWork",
      ],
      {
        runtime,
        session: fakeSession,
      },
    );

    const activeRuntime = {
      db: {
        upsertActivitySuccess() { throw new Error("forced db write failure"); },
        pruneRetrievalTraceSamples() {},
        insertRetrievalTraceSample() {},
      },
      config: { traceRecorder: { durableMaxRowsPerRepository: 120, durableMaxRowsGlobal: 240, durableMaxAgeMs: 1000 } },
      tracePersistenceWrites: 0,
    };

    const traceResult = {
      id: "trace-warn-1",
      record: {
        recordedAt: "2026-01-01T00:00:00.000Z",
        output: { sectionTitles: [], contextInjected: false },
      },
      durableSelected: false,
    };

    persistTraceSuccess({
      activeRuntime,
      repository: "owner/repo",
      traceResult,
      durationMs: 10,
      hook: "onSessionStart",
      session: fakeSession,
    });

    // Wait for the microtask to run
    await new Promise((res) => setTimeout(res, 20));

    assert.ok(warnings.length >= 1, `expected at least one warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(
      warnings[0].includes("lore trace persistence warning:"),
      `warning message should include 'lore trace persistence warning:', got: ${warnings[0]}`,
    );
  });
});
