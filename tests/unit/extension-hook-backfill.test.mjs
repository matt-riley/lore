import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { makeSourceExtractor, findBalancedIndex } from "../helpers/source-parser.mjs";

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

describe("extension hook backfill helpers", () => {
  test("loadSessionStartBackfillDecisionState skips preview work for an already running import", async () => {
    const { loadSessionStartBackfillDecisionState } = loadFunctions(
      ["loadSessionStartBackfillDecisionState"],
      {
        async buildSessionStartBackfillPreview() {
          throw new Error("should not preview when the latest run is already running");
        },
        buildSessionStartBackfillDecision({ preview, latestRun }) {
          assert.equal(preview, null);
          assert.equal(latestRun.id, "run-1");
          return {
            action: "resume",
            reason: "existing_run",
            candidateCount: 12,
            runId: "run-1",
          };
        },
      },
    );

    const latestRun = { id: "run-1", status: "running", total_candidates: 12 };
    const state = await loadSessionStartBackfillDecisionState({
      activeRuntime: {
        db: {
          listBackfillRuns() {
            return [latestRun];
          },
        },
        sessionStore: { label: "session-store" },
      },
      repository: "owner/repo",
      options: {
        includeOtherRepositories: true,
        maxCandidates: 25,
        maxInspected: 100,
        refreshExisting: false,
      },
    });

    assert.deepStrictEqual(state, {
      latestRun,
      preview: null,
      decision: {
        action: "resume",
        reason: "existing_run",
        candidateCount: 12,
        runId: "run-1",
      },
    });
  });

  test("shouldReportSessionStartBackfillProgress gates intermediate logs on force, completion, or thresholds", () => {
    const shouldReportSessionStartBackfillProgress = loadFunction("shouldReportSessionStartBackfillProgress");

    assert.equal(
      shouldReportSessionStartBackfillProgress({
        force: false,
        currentRun: { status: "running" },
        progress: { completedCount: 0 },
        lastReportedCompleted: 0,
        hasReportedIntermediateProgress: false,
        notifyEveryItems: 10,
      }),
      false,
    );

    assert.equal(
      shouldReportSessionStartBackfillProgress({
        force: false,
        currentRun: { status: "running" },
        progress: { completedCount: 1 },
        lastReportedCompleted: 0,
        hasReportedIntermediateProgress: false,
        notifyEveryItems: 10,
      }),
      true,
    );
  });

  test("reportSessionStartBackfillProgress logs and advances progress state only when reporting is due", async () => {
    const logged = [];
    const { reportSessionStartBackfillProgress } = loadFunctions(
      ["reportSessionStartBackfillProgress"],
      {
        summarizeBackfillRunProgress() {
          return {
            completedCount: 5,
            totalCount: 8,
            progressPercent: 63,
            createdCount: 3,
            refreshedCount: 2,
            failedCount: 0,
          };
        },
        shouldReportSessionStartBackfillProgress() {
          return true;
        },
        buildSessionStartBackfillScopeDescription() {
          return "all repositories";
        },
        buildSessionStartBackfillProgressMessage({ scopeLabel }) {
          return `progress:${scopeLabel}`;
        },
      },
    );

    const state = await reportSessionStartBackfillProgress({
      session: {
        async log(message, options) {
          logged.push({ message, options });
        },
      },
      currentRun: { status: "running" },
      repository: "owner/repo",
      options: {
        includeOtherRepositories: true,
        notifyEveryItems: 10,
      },
      currentScopeLabel: "all repositories",
      state: {
        lastReportedCompleted: 0,
        hasReportedIntermediateProgress: false,
      },
      force: false,
    });

    assert.deepStrictEqual(state, {
      lastReportedCompleted: 5,
      hasReportedIntermediateProgress: true,
    });
    assert.deepStrictEqual(logged, [{
      message: "progress:all repositories",
      options: { ephemeral: true },
    }]);
  });

  test("runSessionStartBackfillWork logs bounded inspection skips without starting a run", async () => {
    const logged = [];
    const { runSessionStartBackfillWork } = loadFunctions(
      [
        "shouldReportSessionStartBackfillProgress",
        "reportSessionStartBackfillProgress",
        "waitForSessionStartBackfillDependencies",
        "initializeSessionStartBackfillRun",
        "drainSessionStartBackfillRun",
        "runSessionStartBackfillWork",
      ],
      {
        async delay() {},
        async loadSessionStartBackfillDecisionState() {
          return {
            latestRun: null,
            preview: {
              inspected: 3,
              inspectionLimit: 8,
              candidates: [],
            },
            decision: {
              action: "skip",
              reason: "inspection_bound",
              candidateCount: 0,
              runId: null,
            },
          };
        },
        startControlledBackfillRun() {
          throw new Error("should not start a run when inspection bounds defer work");
        },
        processControlledBackfillRun() {
          throw new Error("should not process batches when inspection bounds defer work");
        },
        summarizeBackfillRunProgress() {
          throw new Error("should not summarize progress when work is skipped");
        },
        buildSessionStartBackfillScopeDescription() {
          return "all repositories";
        },
        buildSessionStartBackfillProgressMessage() {
          return "unused";
        },
        summarizeBackfillRunProgress() {
          throw new Error("should not summarize progress when work is skipped");
        },
      },
    );

    await runSessionStartBackfillWork({
      session: {
        async log(message, options) {
          logged.push({ message, options });
        },
      },
      activeRuntime: {
        db: { label: "fixture-db" },
        sessionStore: { label: "session-store" },
        processingMaintenance: false,
        processingDeferred: false,
      },
      repository: "owner/repo",
      options: {
        includeOtherRepositories: true,
        maxInspected: 50,
        notifyEveryItems: 10,
        batchSize: 5,
      },
      currentScopeLabel: "all repositories",
    });

    assert.deepStrictEqual(logged, [{
      message: "lore archive import deferred for all repositories: inspected 3/8 session(s) without finding pending candidates. More history remains for future startup sweeps.",
      options: { ephemeral: true },
    }]);
  });

  test("waitForSessionStartBackfillDependencies yields until maintenance and deferred work clear", async () => {
    const waits = [];
    const { waitForSessionStartBackfillDependencies } = loadFunctions(
      ["waitForSessionStartBackfillDependencies"],
      {
        async delay(ms) {
          waits.push(ms);
          activeRuntime.processingMaintenance = false;
          activeRuntime.processingDeferred = false;
        },
      },
    );
    const activeRuntime = {
      processingMaintenance: true,
      processingDeferred: true,
    };

    await waitForSessionStartBackfillDependencies(activeRuntime);

    assert.deepStrictEqual(waits, [25]);
  });

  test("initializeSessionStartBackfillRun resumes an existing run and seeds report state", async () => {
    const logged = [];
    const { initializeSessionStartBackfillRun } = loadFunctions(
      ["initializeSessionStartBackfillRun"],
      {
        summarizeBackfillRunProgress() {
          return {
            completedCount: 3,
            totalCount: 7,
            progressPercent: 43,
          };
        },
        buildSessionStartBackfillScopeDescription() {
          return "all repositories";
        },
        startControlledBackfillRun() {
          throw new Error("should not create a new run when resuming");
        },
      },
    );
    const latestRun = { id: "run-1", status: "running" };

    const result = await initializeSessionStartBackfillRun({
      session: {
        async log(message, options) {
          logged.push({ message, options });
        },
      },
      activeRuntime: {
        db: { label: "fixture-db" },
        sessionStore: { label: "session-store" },
      },
      repository: "owner/repo",
      options: {
        includeOtherRepositories: true,
        maxCandidates: 25,
        refreshExisting: false,
        batchSize: 5,
        maxInspected: 100,
      },
      currentScopeLabel: "all repositories",
      latestRun,
      preview: null,
      decision: {
        action: "resume",
        reason: "existing_run",
        candidateCount: 7,
        runId: "run-1",
      },
    });

    assert.deepStrictEqual(result, {
      run: latestRun,
      state: {
        lastReportedCompleted: 3,
        hasReportedIntermediateProgress: false,
      },
    });
    assert.deepStrictEqual(logged, [{
      message: "lore archive import resumed for all repositories: 3/7 (43%)",
      options: { ephemeral: true },
    }]);
  });
});
