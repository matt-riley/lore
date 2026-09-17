import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  RERANK_SCORE_LEVELS,
  TYPESAFE_API_KEY_ENV,
  rerankMemories,
} from "../../lib/inference/typesafe-rerank.mjs";

const TEST_KEY = "test-key-should-never-appear-in-traces";
const ENV = { [TYPESAFE_API_KEY_ENV]: TEST_KEY };

function typesafeConfig({ rerank, ...overrides } = {}) {
  return {
    typesafe: {
      enabled: true,
      model: "jev-latest",
      timeoutMs: 1000,
      ...overrides,
      rerank: { enabled: true, maxCandidates: 6, ...rerank },
    },
  };
}

function memory(id, content, type = "user_preference") {
  return { id, type, content, score: 0.42 };
}

function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options, body: JSON.parse(String(options.body)) });
    return handler({ url, options, index: calls.length - 1 });
  };
  return { fetchImpl, calls };
}

function scoreAnswers(scores, usage = { input_tokens: 42, output_tokens: 3 }) {
  const answers = {};
  for (const [key, score] of Object.entries(scores)) {
    answers[key] = {
      type: "score",
      score,
      confidence: 0.9,
      legend: Object.fromEntries(RERANK_SCORE_LEVELS.map((level, index) => [String(index), level])),
      probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 },
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: "jev-latest", answers, usage }),
  };
}

describe("rerankMemories", () => {
  const rows = [
    memory("mem-a", "Always write tests before merging."),
    memory("mem-b", "The staging database runs on port 5432."),
    memory("mem-c", "Prefer oxlint over eslint for this repo."),
  ];

  test("reads the API key from the config before the environment", async () => {
    const { fetchImpl, calls } = makeFetch(() => scoreAnswers({ memory_0: 1, memory_1: 0 }));
    await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig({ apiKey: "from-config" }),
      fetchImpl,
      env: { ...ENV },
    });
    assert.equal(calls[0].options.headers.authorization, "Bearer from-config");

    const { fetchImpl: envFetch, calls: envCalls } = makeFetch(() => scoreAnswers({ memory_0: 1, memory_1: 0 }));
    await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig(),
      fetchImpl: envFetch,
      env: ENV,
    });
    assert.equal(envCalls[0].options.headers.authorization, `Bearer ${TEST_KEY}`);
  });

  test("sends one score question per candidate over shared state", async () => {
    const { fetchImpl, calls } = makeFetch(() => scoreAnswers({
      memory_0: 0.1,
      memory_1: 0.2,
      memory_2: 0.3,
    }));
    await rerankMemories({
      prompt: "How should I lint this repo?",
      rows,
      config: typesafeConfig(),
      fetchImpl,
      env: ENV,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers.authorization, `Bearer ${TEST_KEY}`);
    const body = calls[0].body;
    assert.equal(body.model, "jev-latest");
    assert.equal(body.state.prompt, "How should I lint this repo?");
    assert.deepEqual(body.state.memories.map((entry) => entry.id), ["mem-a", "mem-b", "mem-c"]);
    assert.deepEqual(Object.keys(body.questions), ["memory_0", "memory_1", "memory_2"]);
    for (const [index, question] of Object.values(body.questions).entries()) {
      assert.equal(question.type, "score");
      assert.deepEqual(question.criteria, [...RERANK_SCORE_LEVELS]);
      assert.match(question.instructions, new RegExp(`memories\\[${index}\\]`));
    }
  });

  test("reorders candidates by probability-weighted score without mutating rows", async () => {
    const { fetchImpl } = makeFetch(() => scoreAnswers({
      memory_0: 0.1,
      memory_1: 1.9,
      memory_2: 0.7,
    }));
    const result = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig(),
      fetchImpl,
      env: ENV,
    });
    assert.equal(result.enabled, true);
    assert.equal(result.applied, true);
    assert.equal(result.reason, "reranked");
    assert.deepEqual(result.rows.map((row) => row.id), ["mem-b", "mem-c", "mem-a"]);
    assert.deepEqual(rows.map((row) => row.id), ["mem-a", "mem-b", "mem-c"]);
    assert.deepEqual(rows.map((row) => row.score), [0.42, 0.42, 0.42]);
    assert.deepEqual(result.trace.rows.map((row) => row.id), ["mem-b", "mem-c", "mem-a"]);
    assert.deepEqual(result.trace.rows.map((row) => row.score), [1.9, 0.7, 0.1]);
    assert.equal(result.trace.reason, "reranked");
    assert.equal(result.trace.enabled, true);
    assert.deepEqual(result.scores.map((entry) => entry.id), ["mem-a", "mem-b", "mem-c"]);
    assert.deepEqual(result.scores.map((entry) => entry.beforeIndex), [0, 1, 2]);
    assert.deepEqual(result.scores.map((entry) => entry.afterIndex), [2, 0, 1]);
  });

  test("keeps unscored candidates after scored ones in their original order", async () => {
    const { fetchImpl } = makeFetch(() => scoreAnswers({
      memory_1: 2.0,
      memory_2: 0.5,
    }));
    const result = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig(),
      fetchImpl,
      env: ENV,
    });
    assert.equal(result.applied, true);
    assert.deepEqual(result.rows.map((row) => row.id), ["mem-b", "mem-c", "mem-a"]);
    assert.equal(result.scores.find((entry) => entry.id === "mem-a").score, null);
  });

  test("treats out-of-range and non-numeric scores as unscored", async () => {
    const { fetchImpl } = makeFetch(() => scoreAnswers({
      memory_0: RERANK_SCORE_LEVELS.length + 5,
      memory_1: "high",
      memory_2: 1.5,
    }));
    const result = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig(),
      fetchImpl,
      env: ENV,
    });
    assert.deepEqual(result.rows.map((row) => row.id), ["mem-c", "mem-a", "mem-b"]);
    assert.equal(result.scores.find((entry) => entry.id === "mem-c").score, 1.5);
  });

  test("fails open with the original order when no answer is usable", async () => {
    const { fetchImpl } = makeFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ model: "jev-latest", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
    }));
    const result = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig(),
      fetchImpl,
      env: ENV,
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "no_usable_answers");
    assert.deepEqual(result.rows.map((row) => row.id), ["mem-a", "mem-b", "mem-c"]);
    assert.match(result.trace.reason, /no_usable_answers/);
  });

  test("fails open on HTTP errors without leaking the key", async () => {
    const { fetchImpl } = makeFetch(() => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));
    const result = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig(),
      fetchImpl,
      env: ENV,
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "request_failed");
    assert.deepEqual(result.rows.map((row) => row.id), ["mem-a", "mem-b", "mem-c"]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_KEY));
    assert.match(result.error, /429/);
  });

  test("fails open on network errors", async () => {
    const { fetchImpl } = makeFetch(() => {
      throw new Error("socket hang up");
    });
    const result = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig(),
      fetchImpl,
      env: ENV,
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "request_failed");
    assert.deepEqual(result.rows.map((row) => row.id), ["mem-a", "mem-b", "mem-c"]);
  });

  test("fails open when the request times out", async () => {
    const fetchImpl = async (_url, options = {}) => new Promise((_, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const result = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig({ timeoutMs: 25 }),
      fetchImpl,
      env: ENV,
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, "request_failed");
    assert.match(result.error, /timed out/i);
  });

  test("fails open when the caller's signal is already aborted", async () => {
    const { fetchImpl, calls } = makeFetch(() => scoreAnswers({ memory_0: 0 }));
    const controller = new AbortController();
    controller.abort();
    const result = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig(),
      fetchImpl,
      signal: controller.signal,
      env: ENV,
    });
    assert.equal(calls.length, 0);
    assert.equal(result.applied, false);
    assert.equal(result.reason, "request_failed");
  });

  test("caps candidates at maxCandidates while keeping the remaining rows", async () => {
    const many = Array.from({ length: 8 }, (_, index) => memory(`mem-${index}`, `Memory ${index}`));
    const { fetchImpl, calls } = makeFetch(() => scoreAnswers({ memory_0: 1, memory_1: 0, memory_2: 0 }));
    const result = await rerankMemories({
      prompt: "Which database?",
      rows: many,
      config: typesafeConfig({ rerank: { maxCandidates: 3 } }),
      fetchImpl,
      env: ENV,
    });
    assert.equal(calls[0].body.state.memories.length, 3);
    assert.deepEqual(calls[0].body.state.memories.map((entry) => entry.id), ["mem-0", "mem-1", "mem-2"]);
    assert.equal(Object.keys(calls[0].body.questions).length, 3);
    assert.equal(result.rows.length, 8);
    assert.deepEqual(result.rows.slice(3).map((row) => row.id), ["mem-3", "mem-4", "mem-5", "mem-6", "mem-7"]);
  });

  test("skips the request for fewer than two candidates", async () => {
    const { fetchImpl, calls } = makeFetch(() => scoreAnswers({ memory_0: 1 }));
    const result = await rerankMemories({
      prompt: "Which database?",
      rows: [rows[0]],
      config: typesafeConfig(),
      fetchImpl,
      env: ENV,
    });
    assert.equal(calls.length, 0);
    assert.equal(result.applied, false);
    assert.equal(result.reason, "too_few_candidates");
    assert.deepEqual(result.rows.map((row) => row.id), ["mem-a"]);
  });

  test("does not call the API when the provider or feature is disabled", async () => {
    const { fetchImpl, calls } = makeFetch(() => scoreAnswers({ memory_0: 1 }));
    const providerOff = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig({ enabled: false }),
      fetchImpl,
      env: ENV,
    });
    assert.equal(providerOff.reason, "typesafe_disabled");
    const featureOff = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig({ rerank: { enabled: false } }),
      fetchImpl,
      env: ENV,
    });
    assert.equal(featureOff.reason, "rerank_disabled");
    const keyless = await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig(),
      fetchImpl,
      env: {},
    });
    assert.equal(keyless.reason, "api_key_missing");
    assert.equal(calls.length, 0);
    assert.equal(providerOff.trace.enabled, false);
  });

  test("uses the configured model when provided", async () => {
    const { fetchImpl, calls } = makeFetch(() => scoreAnswers({ memory_0: 1, memory_1: 0 }));
    await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig({ model: "" }),
      fetchImpl,
      env: ENV,
    });
    assert.equal(calls[0].body.model, "jev-latest");
    const { fetchImpl: secondFetch, calls: secondCalls } = makeFetch(() => scoreAnswers({ memory_0: 1, memory_1: 0 }));
    await rerankMemories({
      prompt: "Which database?",
      rows,
      config: typesafeConfig({ model: "jev-1.13" }),
      fetchImpl: secondFetch,
      env: ENV,
    });
    assert.equal(secondCalls[0].body.model, "jev-1.13");
  });
});
