/**
 * Source-parser regression tests for extension hook paths that depend on the
 * lifecycle wiring. The lifecycle implementation itself is covered by
 * runtime-lifecycle.test.mjs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { createRuntimeLifecycle } from "../../lib/lifecycle/runtime-lifecycle.mjs";
import { makeSourceExtractor } from "../helpers/source-parser.mjs";

const EXTENSION_SOURCE = readFileSync(new URL("../../extension.mjs", import.meta.url), "utf8");
const extractFunctionSource = makeSourceExtractor(EXTENSION_SOURCE);

function loadFunctions(names, dependencies = {}) {
  const functionSources = names.map((name) => extractFunctionSource(name)).join("\n\n");
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; ${functionSources}; return { ${names.join(", ")} };`,
  )(...Object.values(dependencies));
}

describe("handleSessionEndHook empty-session shutdown", () => {
  test("drains pending background work and closes the DB once when no session artifacts exist", async () => {
    const closeCalls = [];
    const runtime = {
      pendingWork: new Set(), shuttingDown: false, initialized: true, lastError: null, config: {},
      db: { close() { closeCalls.push("close"); } },
    };
    let workSettled = false;
    const work = new Promise((res) => setTimeout(() => { workSettled = true; res(); }, 5));
    runtime.pendingWork.add(work);
    work.then(() => runtime.pendingWork.delete(work));

    const { shutdownRuntime } = createRuntimeLifecycle(runtime);
    const { handleSessionEndHook } = loadFunctions(["handleSessionEndHook"], {
      runtime, shutdownRuntime,
      getContext: async () => ({ runtime, workspace: "/fake/ws", repository: "owner/repo" }),
      hooksEnabled: () => true,
      readSessionEndExtraction: () => null,
      applySessionExtraction: () => { throw new Error("must not be called for empty session"); },
      maybeEnqueueDeferredSessionExtraction: () => { throw new Error("must not be called for empty session"); },
    });

    await handleSessionEndHook({
      session: { async log() {} },
      invocation: { sessionId: "session-empty-regression" },
      input: { cwd: "/fake/cwd", reason: "normal" },
    });
    assert.equal(closeCalls.length, 1);
    assert.equal(runtime.db, null);
    assert.equal(runtime.shuttingDown, true);
    assert.equal(workSettled, true);
    assert.equal(runtime.pendingWork.size, 0);
  });
});

describe("persistTraceSuccess trace-persistence warning", () => {
  test("logs warning via session when trace persistence throws", async () => {
    const warnings = [];
    const fakeSession = { async log(message, options) { if (options?.level === "warning") warnings.push(message); } };
    const runtime = { pendingWork: new Set(), shuttingDown: false };
    const { spawnTrackedMicrotask } = createRuntimeLifecycle(runtime);
    const { persistTraceSuccess } = loadFunctions([
      "resolveTraceSuccessRecord", "buildTraceSuccessUpdates", "buildDurableTraceSampleRecordFields",
      "buildDurableTraceSampleEvidenceFields", "buildDurableTraceSamplePayload",
      "persistTraceContextInjectionUpdates", "maybePruneDurableTraceSamples", "persistDurableTraceSample",
      "writeActivitySuccessUpdates", "persistTraceSuccess",
    ], { runtime, spawnTrackedMicrotask, session: fakeSession });

    const activeRuntime = {
      db: {
        upsertActivitySuccess() { throw new Error("forced db write failure"); },
        pruneRetrievalTraceSamples() {}, insertRetrievalTraceSample() {},
      },
      config: { traceRecorder: { durableMaxRowsPerRepository: 120, durableMaxRowsGlobal: 240, durableMaxAgeMs: 1000 } },
      tracePersistenceWrites: 0,
    };
    persistTraceSuccess({
      activeRuntime, repository: "owner/repo",
      traceResult: {
        id: "trace-warn-1",
        record: { recordedAt: "2026-01-01T00:00:00.000Z", output: { sectionTitles: [], contextInjected: false } },
        durableSelected: false,
      },
      durationMs: 10, hook: "onSessionStart", session: fakeSession,
    });
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(warnings[0]?.includes("lore trace persistence warning:"));
  });
});
