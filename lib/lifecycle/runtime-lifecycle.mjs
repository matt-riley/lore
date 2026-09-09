import { setTimeout as delay } from "node:timers/promises";

/**
 * Build background-work tracking and bounded shutdown for an extension runtime.
 * Timing dependencies are injectable so this lifecycle can be tested without
 * loading the client-specific extension entrypoint.
 *
 * @param {{ pendingWork: Set<Promise<unknown>>, shuttingDown: boolean, db?: { close?: () => void } | null, loreSession?: { close?: () => void } | null }} runtime
 * @param {{ delay?: (milliseconds: number) => Promise<unknown>, setTimeout?: typeof globalThis.setTimeout }} [dependencies]
 */
export function createRuntimeLifecycle(runtime, dependencies = {}) {
  const wait = dependencies.delay ?? delay;
  const schedule = dependencies.setTimeout ?? globalThis.setTimeout;

  function trackBackgroundWork(promise) {
    runtime.pendingWork.add(promise);
    promise.then(
      () => runtime.pendingWork.delete(promise),
      () => runtime.pendingWork.delete(promise),
    );
  }

  function spawnTrackedMicrotask(fn) {
    if (runtime.shuttingDown) return;
    trackBackgroundWork(Promise.resolve().then(fn));
  }

  function spawnTrackedDeferredTask(fn) {
    if (runtime.shuttingDown) return;
    const promise = new Promise((resolve, reject) => {
      schedule(() => Promise.resolve().then(fn).then(resolve, reject), 0);
    });
    trackBackgroundWork(promise);
  }

  async function shutdownRuntime(_session, gracePeriodMs = 4000) {
    if (runtime.shuttingDown) return;
    runtime.shuttingDown = true;

    if (runtime.pendingWork.size > 0) {
      await Promise.race([
        Promise.allSettled(runtime.pendingWork),
        wait(gracePeriodMs),
      ]);
    }

    try {
      runtime.loreSession?.close?.();
    } catch {
      // best-effort close; never rethrow from shutdown path
    }
    try {
      runtime.db?.close?.();
    } catch {
      // best-effort close; never rethrow from shutdown path
    }
    runtime.db = null;
    runtime.loreSession = null;
  }

  return { trackBackgroundWork, spawnTrackedMicrotask, spawnTrackedDeferredTask, shutdownRuntime };
}
