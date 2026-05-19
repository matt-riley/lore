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

describe("extension hook trace helpers", () => {
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
});
