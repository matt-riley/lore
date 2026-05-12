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

describe("extension hook hotspot helpers", () => {
  test("writeActivitySuccessUpdates mirrors repo writes to the global activity row", () => {
    const writes = [];
    const writeActivitySuccessUpdates = loadFunction("writeActivitySuccessUpdates");
    const updates = { lastTraceId: "trace-1" };

    writeActivitySuccessUpdates({
      db: {
        upsertActivitySuccess(entry) {
          writes.push(entry);
        },
      },
      repository: "owner/repo",
      updates,
    });

    assert.deepStrictEqual(writes, [
      { repository: "owner/repo", updates },
      { repository: null, updates },
    ]);
  });

  test("buildTraceSuccessUpdates keeps context injection writes gated on injected output", () => {
    const buildTraceSuccessUpdates = loadFunction("buildTraceSuccessUpdates");
    const recordedAt = "2026-05-07T12:34:56.000Z";

    const withoutContext = buildTraceSuccessUpdates({
      traceRecord: {
        recordedAt,
        output: {
          contextInjected: false,
          sectionTitles: [],
        },
      },
      traceId: "trace-1",
      durationMs: 17,
      hook: "onSessionStart",
    });

    assert.deepStrictEqual(withoutContext, {
      recordedAt,
      traceUpdates: {
        lastTraceRecordedAt: recordedAt,
        lastTraceHook: "onSessionStart",
        lastTraceId: "trace-1",
      },
      contextInjectionUpdates: null,
    });

    const withSections = buildTraceSuccessUpdates({
      traceRecord: {
        recordedAt,
        output: {
          contextInjected: false,
          sectionTitles: ["Recent Related Work"],
        },
      },
      traceId: "trace-2",
      durationMs: 42,
      hook: "onUserPromptSubmitted",
    });

    assert.deepStrictEqual(withSections.contextInjectionUpdates, {
      lastContextInjectionAt: recordedAt,
      lastContextInjectionHook: "onUserPromptSubmitted",
      lastContextInjectionSections: ["Recent Related Work"],
      lastContextInjectionTraceId: "trace-2",
      lastContextInjectionDurationMs: 42,
    });
  });

  test("maybeSeedSessionStartOnboarding logs only when it inserts the default profile", async () => {
    const logged = [];
    const maybeSeedSessionStartOnboarding = loadFunction("maybeSeedSessionStartOnboarding", {
      seedOnboardingMemories({ db, sessionId }) {
        assert.equal(db.label, "fixture-db");
        assert.equal(sessionId, "session-1");
        return { insertedCount: 1, after: null };
      },
    });

    const session = {
      async log(message, options) {
        logged.push({ message, options });
      },
    };

    const seeded = await maybeSeedSessionStartOnboarding(
      session,
      { db: { label: "fixture-db" } },
      "session-1",
    );
    assert.deepStrictEqual(seeded, { insertedCount: 1, after: null });
    assert.deepStrictEqual(logged, [{
      message: "lore onboarding bootstrapped a default personality profile",
      options: { ephemeral: true },
    }]);

    logged.length = 0;
    const silentSeed = loadFunction("maybeSeedSessionStartOnboarding", {
      seedOnboardingMemories() {
        return { insertedCount: 0, after: null };
      },
    });

    await silentSeed(session, { db: { label: "fixture-db" } }, "session-2");
    assert.deepStrictEqual(logged, []);
  });

  test("assembleSessionStartCapsule skips capsule assembly when no db is available", async () => {
    const profileCalls = [];
    const assembleSessionStartCapsule = loadFunction("assembleSessionStartCapsule", {
      capsuleCache: new Map(),
      detectRelevantInstructionFiles(prompt) {
        return [`instructions:${prompt}`];
      },
      async buildProceduralProfile(args) {
        profileCalls.push(args);
        return "profile";
      },
      buildDbWatermark() {
        return "none";
      },
      cacheKey(parts) {
        return parts.join("::");
      },
      readCache() {
        throw new Error("should not read cache without a db");
      },
      writeCache() {
        throw new Error("should not write cache without a db");
      },
      async assembleMemoryCapsule() {
        throw new Error("should not assemble without a db");
      },
    });

    const result = await assembleSessionStartCapsule({
      prompt: "Need a recap",
      repository: "owner/repo",
      activeRuntime: {
        db: null,
        config: { enabled: true },
        traceRecorder: null,
        sessionStore: null,
      },
    });

    assert.equal(profileCalls.length, 1);
    assert.deepStrictEqual(result.assembled, { text: "", sections: [] });
    assert.match(result.startCacheKey, /context-only$/);
  });

  test("assembleSessionStartCapsule reuses cached capsule results for matching inputs", async () => {
    let assembleCalls = 0;
    const capsuleCache = new Map();
    const assembleSessionStartCapsule = loadFunction("assembleSessionStartCapsule", {
      capsuleCache,
      detectRelevantInstructionFiles() {
        return ["instructions.md"];
      },
      async buildProceduralProfile() {
        return "procedural-profile";
      },
      buildDbWatermark() {
        return "watermark-1";
      },
      cacheKey(parts) {
        return parts.join("::");
      },
      readCache(map, key) {
        return map.get(key) ?? null;
      },
      writeCache(map, key, value) {
        map.set(key, value);
        return value;
      },
      async assembleMemoryCapsule(args) {
        assembleCalls += 1;
        return {
          text: `capsule-${assembleCalls}`,
          sections: [],
          trace: {
            includeTrace: args.includeTrace,
          },
        };
      },
    });

    const activeRuntime = {
      db: { label: "fixture-db" },
      config: { enabled: true },
      traceRecorder: {
        isEnabled() {
          return true;
        },
      },
      sessionStore: { label: "session-store" },
    };

    const first = await assembleSessionStartCapsule({
      prompt: "Need a recap",
      repository: "owner/repo",
      activeRuntime,
    });
    const second = await assembleSessionStartCapsule({
      prompt: "Need a recap",
      repository: "owner/repo",
      activeRuntime,
    });

    assert.equal(assembleCalls, 1);
    assert.equal(first.assembled.text, "capsule-1");
    assert.equal(second.assembled.text, "capsule-1");
    assert.equal(first.assembled.trace.includeTrace, true);
  });

  test("buildDurableTraceSamplePayload preserves trace fields and repo scope", () => {
    const { buildDurableTraceSamplePayload } = loadFunctions([
      "buildDurableTraceSampleRecordFields",
      "buildDurableTraceSampleEvidenceFields",
      "buildDurableTraceSamplePayload",
    ]);

    const payload = buildDurableTraceSamplePayload({
      repository: "owner/repo",
      traceRecord: {
        routerDecision: {
          route: "session_start_capsule",
          reason: "cache_miss",
        },
        output: {
          contextInjected: true,
          sectionTitles: ["Recent Related Work"],
        },
        latencyMs: 18,
        promptPreview: "Need a recap",
        promptNeed: {
          requiresLookup: true,
        },
        eligibility: {
          local: ["repo:owner/repo"],
        },
        lookups: {
          localEpisodes: {
            matchedCount: 1,
          },
        },
        omissions: [{ stage: "style", reason: "serious_prompt" }],
        mode: "legacy_prompt_context",
      },
      traceId: "trace-1",
      hook: "onSessionStart",
      recordedAt: "2026-05-08T09:00:00.000Z",
    });

    assert.deepStrictEqual(payload, {
      id: "trace-1",
      repository: "owner/repo",
      scopeType: "repo",
      hook: "onSessionStart",
      route: "session_start_capsule",
      routeReason: "cache_miss",
      contextInjected: true,
      latencyMs: 18,
      promptPreview: "Need a recap",
      sectionTitles: ["Recent Related Work"],
      promptNeed: {
        requiresLookup: true,
      },
      eligibility: {
        local: ["repo:owner/repo"],
      },
      lookups: {
        localEpisodes: {
          matchedCount: 1,
        },
      },
      omissions: [{ stage: "style", reason: "serious_prompt" }],
      output: {
        contextInjected: true,
        sectionTitles: ["Recent Related Work"],
      },
      trace: {
        mode: "legacy_prompt_context",
      },
      recordedAt: "2026-05-08T09:00:00.000Z",
    });
  });

  test("buildDurableTraceSampleRecordFields preserves route and context defaults", () => {
    const buildDurableTraceSampleRecordFields = loadFunction("buildDurableTraceSampleRecordFields");

    assert.deepStrictEqual(
      buildDurableTraceSampleRecordFields({
        routerDecision: {
          route: "memory_recall",
          reason: "recent_context",
        },
        output: {
          contextInjected: true,
          sectionTitles: ["Relevant Knowledge"],
        },
        latencyMs: 21,
        promptPreview: "What changed?",
      }),
      {
        route: "memory_recall",
        routeReason: "recent_context",
        contextInjected: true,
        latencyMs: 21,
        promptPreview: "What changed?",
        sectionTitles: ["Relevant Knowledge"],
      },
    );

    assert.deepStrictEqual(
      buildDurableTraceSampleRecordFields({}),
      {
        route: null,
        routeReason: null,
        contextInjected: false,
        latencyMs: null,
        promptPreview: "",
        sectionTitles: [],
      },
    );
  });

  test("buildDurableTraceSampleEvidenceFields preserves trace evidence with stable fallbacks", () => {
    const buildDurableTraceSampleEvidenceFields = loadFunction("buildDurableTraceSampleEvidenceFields");

    assert.deepStrictEqual(
      buildDurableTraceSampleEvidenceFields({
        promptNeed: { requiresLookup: true },
        eligibility: { local: ["repo:owner/repo"] },
        lookups: { localEpisodes: { matchedCount: 2 } },
        omissions: [{ stage: "style", reason: "serious_prompt" }],
        output: { contextInjected: true },
        mode: "legacy_prompt_context",
      }),
      {
        promptNeed: { requiresLookup: true },
        eligibility: { local: ["repo:owner/repo"] },
        lookups: { localEpisodes: { matchedCount: 2 } },
        omissions: [{ stage: "style", reason: "serious_prompt" }],
        output: { contextInjected: true },
        trace: { mode: "legacy_prompt_context" },
      },
    );

    assert.deepStrictEqual(
      buildDurableTraceSampleEvidenceFields({}),
      {
        promptNeed: {},
        eligibility: {},
        lookups: {},
        omissions: [],
        output: {},
        trace: { mode: null },
      },
    );
  });

  test("maybePruneDurableTraceSamples increments writes and prunes on the tenth sample", () => {
    const prunes = [];
    const maybePruneDurableTraceSamples = loadFunction("maybePruneDurableTraceSamples");
    const activeRuntime = {
      tracePersistenceWrites: 9,
      db: {
        pruneRetrievalTraceSamples(args) {
          prunes.push(args);
        },
      },
      config: {
        traceRecorder: {
          durableMaxRowsPerRepository: 7,
          durableMaxRowsGlobal: 11,
          durableMaxAgeMs: 13,
        },
      },
    };

    maybePruneDurableTraceSamples({
      activeRuntime,
      repository: "owner/repo",
    });

    assert.equal(activeRuntime.tracePersistenceWrites, 10);
    assert.deepStrictEqual(prunes, [{
      repository: "owner/repo",
      maxRowsPerRepository: 7,
      maxRowsGlobal: 11,
      maxAgeMs: 13,
    }]);
  });

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
