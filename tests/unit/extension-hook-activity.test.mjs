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

describe("extension hook activity helpers", () => {
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
});
