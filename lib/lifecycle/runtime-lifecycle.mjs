/**
 * Build background-work tracking and bounded shutdown for an extension runtime.
 * Timing dependencies are injectable so this lifecycle can be tested without
 * loading the client-specific extension entrypoint.
 *
 * @param {{ pendingWork: Set<Promise<unknown>>, shuttingDown: boolean, db?: { close?: () => void } | null, loreSession?: { close?: () => void } | null }} runtime
 * @param {{ setTimeout?: typeof globalThis.setTimeout, clearTimeout?: typeof globalThis.clearTimeout }} [dependencies]
 */
export function createRuntimeLifecycle(runtime, dependencies = {}) {
  const schedule = dependencies.setTimeout ?? globalThis.setTimeout;
  const cancel = dependencies.clearTimeout ?? globalThis.clearTimeout;
  const deferredTimers = new Map();

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
    let timerId;
    let cancelTask;
    const promise = new Promise((resolve, reject) => {
      cancelTask = () => resolve();
      timerId = schedule(() => {
        deferredTimers.delete(promise);
        Promise.resolve().then(fn).then(resolve, reject);
      }, 0);
    });
    deferredTimers.set(promise, { cancel: () => { cancel(timerId); cancelTask(); } });
    trackBackgroundWork(promise);
  }

  function cancelPendingDeferredTasks() {
    for (const { cancel: cancelTask } of deferredTimers.values()) {
      cancelTask();
    }
    deferredTimers.clear();
  }

  async function shutdownRuntime(_session, gracePeriodMs = 4000) {
    if (runtime.shuttingDown) return;
    runtime.shuttingDown = true;

    if (runtime.pendingWork.size > 0) {
      let graceTimer;
      const gracePeriod = new Promise((resolve) => {
        graceTimer = schedule(resolve, gracePeriodMs);
      });
      await Promise.race([Promise.allSettled(runtime.pendingWork), gracePeriod]);
      cancel(graceTimer);
      cancelPendingDeferredTasks();
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
