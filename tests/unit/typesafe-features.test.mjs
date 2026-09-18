import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_MIN_DURABILITY,
  scoreMemoryFeatures,
  typesafeFeaturesEnabled,
} from "../../lib/inference/typesafe-features.mjs";

const ENV = { LORE_TYPESAFE_API_KEY: "feature-key" };

function featuresConfig(overrides = {}) {
  const { features, ...rest } = overrides;
  return {
    typesafe: {
      enabled: true,
      model: "jev-latest",
      timeoutMs: 1000,
      ...rest,
      features: { enabled: true, minDurability: DEFAULT_MIN_DURABILITY, maxMemoriesPerRun: 8, ...features },
    },
  };
}

function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)), init });
    return handler(calls.length);
  };
  return { fetchImpl, calls };
}

function answersFor(count, scores = {}) {
  const answers = {};
  for (let index = 0; index < count; index += 1) {
    answers[`durable_${index}`] = { type: "noul", noul: scores[index]?.durability ?? 0.9 };
    answers[`specific_${index}`] = { type: "score", score: scores[index]?.specificity ?? 1.4, confidence: 0.8 };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: "jev-latest", answers, usage: { input_tokens: 40, output_tokens: 6 } }),
  };
}

// Assembled at runtime so secret scanners never match a literal key here.
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

const memories = [
  { id: "one-off", type: "directive", content: "There should be a live Env key" },
  { id: "policy", type: "directive", content: "Prefer Node built-ins for runtime work." },
];

describe("typesafeFeaturesEnabled", () => {
  test("requires the provider, the features switch and a key", () => {
    assert.equal(typesafeFeaturesEnabled(featuresConfig(), ENV), true);
    assert.equal(typesafeFeaturesEnabled(featuresConfig({ enabled: false }), ENV), false);
    assert.equal(typesafeFeaturesEnabled(featuresConfig({ features: { enabled: false } }), ENV), false);
    assert.equal(typesafeFeaturesEnabled(featuresConfig(), {}), false);
  });
});

describe("scoreMemoryFeatures", () => {
  test("asks a durability and a specificity question per memory in one request", async () => {
    const { fetchImpl, calls } = makeFetch(() => answersFor(memories.length));
    const result = await scoreMemoryFeatures({ memories, config: featuresConfig(), fetchImpl, env: ENV });

    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0].body.questions).sort(), [
      "durable_0", "durable_1", "specific_0", "specific_1",
    ]);
    assert.equal(calls[0].body.state.memories.length, 2);
    assert.equal(calls[0].body.state.memories[0].id, "one-off");
    assert.equal(result.enabled, true);
    assert.equal(result.applied, true);
    assert.equal(result.reason, "scored");
    assert.equal(result.model, "jev-latest");
  });

  test("returns the scores keyed by memory id with provenance", async () => {
    const { fetchImpl } = makeFetch(() => answersFor(memories.length, [
      { durability: 0.14, specificity: 0.3 },
      { durability: 0.9, specificity: 1.6 },
    ]));
    const result = await scoreMemoryFeatures({ memories, config: featuresConfig(), fetchImpl, env: ENV });
    assert.equal(result.features.length, 2);

    const oneOff = result.features.find((feature) => feature.id === "one-off");
    assert.equal(oneOff.durability, 0.14);
    assert.equal(oneOff.specificity, 0.3);
    assert.equal(oneOff.model, "jev-latest");
    assert.match(oneOff.scoredAt, /^\d{4}-\d{2}-\d{2}T/);

    const policy = result.features.find((feature) => feature.id === "policy");
    assert.equal(policy.durability, 0.9);
    assert.equal(policy.specificity, 1.6);
  });

  test("never sends sensitive content and reports what it withheld", async () => {
    const withSecret = [
      ...memories,
      { id: "secret", type: "fact", content: `The deploy key is ${AWS_KEY}` },
    ];
    const { fetchImpl, calls } = makeFetch(() => answersFor(2));
    const result = await scoreMemoryFeatures({ memories: withSecret, config: featuresConfig(), fetchImpl, env: ENV });

    assert.deepEqual(calls[0].body.state.memories.map((memory) => memory.id), ["one-off", "policy"]);
    assert.equal(result.withheldSensitive, 1);
    assert.equal(result.features.some((feature) => feature.id === "secret"), false);
  });

  test("bounds the batch per run", async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ id: `mem-${index}`, type: "fact", content: `Fact ${index}` }));
    const { fetchImpl, calls } = makeFetch(() => answersFor(2));
    const result = await scoreMemoryFeatures({
      memories: many,
      config: featuresConfig({ features: { maxMemoriesPerRun: 2 } }),
      fetchImpl,
      env: ENV,
    });
    assert.equal(calls[0].body.state.memories.length, 2);
    assert.deepEqual(calls[0].body.state.memories.map((memory) => memory.id), ["mem-0", "mem-1"]);
    assert.equal(result.considered, 2);
  });

  test("fails open when the request fails", async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
    const result = await scoreMemoryFeatures({ memories, config: featuresConfig(), fetchImpl, env: ENV });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "request_failed");
    assert.match(result.error, /429/);
    assert.deepEqual(result.features, []);
  });

  test("reports unusable answers instead of inventing scores", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ model: "jev-latest", answers: {}, usage: {} }),
    });
    const result = await scoreMemoryFeatures({ memories, config: featuresConfig(), fetchImpl, env: ENV });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "no_usable_answers");
    assert.deepEqual(result.features, []);
  });

  test("does nothing without memories or without enablement", async () => {
    const { fetchImpl, calls } = makeFetch(() => answersFor(0));
    const empty = await scoreMemoryFeatures({ memories: [], config: featuresConfig(), fetchImpl, env: ENV });
    assert.equal(empty.reason, "no_memories");
    const disabled = await scoreMemoryFeatures({ memories, config: featuresConfig({ features: { enabled: false } }), fetchImpl, env: ENV });
    assert.equal(disabled.reason, "features_disabled");
    const keyless = await scoreMemoryFeatures({ memories, config: featuresConfig(), fetchImpl, env: {} });
    assert.equal(keyless.reason, "api_key_missing");
    assert.equal(calls.length, 0);
  });
});
