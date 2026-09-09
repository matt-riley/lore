/** Tests for the production runtime background-work and shutdown lifecycle. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createRuntimeLifecycle } from "../../lib/lifecycle/runtime-lifecycle.mjs";

function manualTimers() {
  let nextId = 0;
  const timers = new Map();
  const cleared = [];
  return {
    setTimeout(callback) {
      const id = ++nextId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    },
    ids() {
      return [...timers.keys()];
    },
    fire(id) {
      const callback = timers.get(id);
      timers.delete(id);
      callback?.();
    },
    cleared,
  };
}

describe("runtime lifecycle background work", () => {
  test("tracks work through resolution and rejection", async () => {
    const runtime = { pendingWork: new Set(), shuttingDown: false };
    const { trackBackgroundWork } = createRuntimeLifecycle(runtime);
    let resolve;
    const pending = new Promise((res) => { resolve = res; });
    trackBackgroundWork(pending);
    assert.equal(runtime.pendingWork.size, 1);
    resolve();
    await pending;
    await Promise.resolve();
    assert.equal(runtime.pendingWork.size, 0);

    const rejected = Promise.reject(new Error("expected rejection"));
    trackBackgroundWork(rejected);
    await assert.rejects(rejected, /expected rejection/);
    await Promise.resolve();
    assert.equal(runtime.pendingWork.size, 0);
  });

  test("does not spawn microtasks or deferred work during shutdown", async () => {
    const runtime = { pendingWork: new Set(), shuttingDown: true };
    const { spawnTrackedMicrotask, spawnTrackedDeferredTask } = createRuntimeLifecycle(runtime);
    let ran = false;
    spawnTrackedMicrotask(async () => { ran = true; });
    spawnTrackedDeferredTask(async () => { ran = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ran, false);
    assert.equal(runtime.pendingWork.size, 0);
  });

  test("tracks microtasks and deferred tasks until they settle", async () => {
    const runtime = { pendingWork: new Set(), shuttingDown: false };
    const { spawnTrackedMicrotask, spawnTrackedDeferredTask } = createRuntimeLifecycle(runtime);
    let count = 0;
    spawnTrackedMicrotask(async () => { count += 1; });
    spawnTrackedDeferredTask(async () => { count += 1; });
    assert.equal(runtime.pendingWork.size, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(count, 2);
    assert.equal(runtime.pendingWork.size, 0);
  });
});

describe("shutdownRuntime", () => {
  test("drains work, closes resources once, and is idempotent", async () => {
    const closeCalls = [];
    const runtime = {
      pendingWork: new Set(), shuttingDown: false,
      loreSession: { close() { closeCalls.push("session"); } },
      db: { close() { closeCalls.push("db"); } },
    };
    const { shutdownRuntime, trackBackgroundWork } = createRuntimeLifecycle(runtime);
    let settled = false;
    const work = new Promise((resolve) => setTimeout(() => { settled = true; resolve(); }, 5));
    trackBackgroundWork(work);
    await shutdownRuntime({}, 100);
    await shutdownRuntime({}, 100);
    assert.equal(settled, true);
    assert.deepEqual(closeCalls, ["session", "db"]);
    assert.equal(runtime.db, null);
    assert.equal(runtime.loreSession, null);
  });

  test("continues cleanup when resource close throws", async () => {
    const closeCalls = [];
    const runtime = {
      pendingWork: new Set(), shuttingDown: false,
      loreSession: { close() { throw new Error("session close failed"); } },
      db: { close() { closeCalls.push("db"); } },
    };
    const { shutdownRuntime } = createRuntimeLifecycle(runtime, { delay: async () => {} });
    await assert.doesNotReject(() => shutdownRuntime({}, 100));
    assert.deepEqual(closeCalls, ["db"]);
    assert.equal(runtime.db, null);
    assert.equal(runtime.loreSession, null);
  });

  test("cancels queued deferred work when grace expires", async () => {
    const timers = manualTimers();
    const runtime = { pendingWork: new Set(), shuttingDown: false, db: { close() {} } };
    const { shutdownRuntime, spawnTrackedDeferredTask } = createRuntimeLifecycle(runtime, timers);
    let ran = false;
    spawnTrackedDeferredTask(async () => { ran = true; });
    const deferredTimer = timers.ids()[0];
    const shutdown = shutdownRuntime({}, 20);
    const graceTimer = timers.ids().find((id) => id !== deferredTimer);
    timers.fire(graceTimer);
    await shutdown;
    assert.equal(ran, false);
    assert.equal(runtime.pendingWork.size, 0);
    assert.ok(timers.cleared.includes(deferredTimer));
    assert.equal(runtime.db, null);
  });

  test("cancels grace timer when tracked work drains early", async () => {
    const timers = manualTimers();
    const runtime = { pendingWork: new Set(), shuttingDown: false, db: { close() {} } };
    const { shutdownRuntime, trackBackgroundWork } = createRuntimeLifecycle(runtime, timers);
    let resolveWork;
    trackBackgroundWork(new Promise((resolve) => { resolveWork = resolve; }));
    const shutdown = shutdownRuntime({}, 20);
    const graceTimer = timers.ids()[0];
    resolveWork();
    await shutdown;
    assert.ok(timers.cleared.includes(graceTimer));
    assert.equal(runtime.db, null);
  });

  test("bounds shutdown while rejected or slow work remains pending", async () => {
    const runtime = { pendingWork: new Set(), shuttingDown: false, db: { close() {} } };
    const { shutdownRuntime, trackBackgroundWork } = createRuntimeLifecycle(runtime);
    const rejected = Promise.reject(new Error("background failure"));
    trackBackgroundWork(rejected);
    await assert.rejects(rejected, /background failure/);
    trackBackgroundWork(new Promise(() => {}));
    await shutdownRuntime({}, 20);
    assert.equal(runtime.db, null);
  });
});
