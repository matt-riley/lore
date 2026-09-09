/** Tests for the production runtime background-work and shutdown lifecycle. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createRuntimeLifecycle } from "../../lib/lifecycle/runtime-lifecycle.mjs";

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
