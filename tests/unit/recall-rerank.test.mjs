import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assembleRecall } from "../../lib/context/recall-assembler.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

const TEST_KEY = "rerank-test-key";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Score the memory named `preferredId` highest, whatever position it lands in. */
function scoringFetch(preferredId, calls = []) {
  const fetchImpl = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body));
    calls.push(body);
    const answers = Object.fromEntries(body.state.memories.map((memory, index) => [
      `memory_${index}`,
      {
        type: "score",
        score: memory.id === preferredId ? 1.9 : 0.2,
        confidence: 0.9,
      },
    ]));
    return jsonResponse({
      model: "jev-latest",
      answers,
      usage: { input_tokens: 40, output_tokens: 8 },
    });
  };
  return { fetchImpl, calls };
}

async function withRerankFixture(configExtras = {}) {
  return withFixtureDb({
    configOverrides: {
      enabled: true,
      rollout: { memoryOperations: true, directives: true },
      typesafe: {
        enabled: true,
        model: "jev-latest",
        timeoutMs: 1000,
        apiKey: TEST_KEY,
        rerank: { enabled: true, maxCandidates: 6 },
        ...configExtras,
      },
    },
  });
}

function insertMemories(db) {
  db.insertSemanticMemory({
    id: "lint-memory",
    type: "user_preference",
    content: "Always run the repository linter before committing changes.",
    repository: "fixture-repo",
    scope: "repo",
    confidence: 1,
    tags: ["lint", "preferences"],
  });
  db.insertSemanticMemory({
    id: "test-memory",
    type: "user_preference",
    content: "Write unit tests before merging any repository change.",
    repository: "fixture-repo",
    scope: "repo",
    confidence: 1,
    tags: ["test", "preferences"],
  });
}

const PROMPT = "How should I lint and test this repository?";

describe("TypeSafe recall reranking", () => {
  test("reorders local memories by rerank score and records the lookup", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withRerankFixture();
    try {
      insertMemories(db);
      const baseline = await assembleRecall({
        db,
        prompt: PROMPT,
        repository: "fixture-repo",
        config: { ...config, typesafe: { ...config.typesafe, enabled: false } },
        fetchImpl: async () => { throw new Error("should not be called"); },
      });
      const baselineOrder = baseline.trace.lookups.localMemories.includedRows.map((row) => row.id);
      assert.equal(baselineOrder.length, 2);
      const preferredId = baselineOrder[baselineOrder.length - 1];
      const expectedOrder = [preferredId, ...baselineOrder.filter((id) => id !== preferredId)];

      const { fetchImpl, calls } = scoringFetch(preferredId);
      const result = await assembleRecall({
        db,
        prompt: PROMPT,
        repository: "fixture-repo",
        config,
        fetchImpl,
      });

      assert.equal(calls.length, 1);
      assert.deepEqual(
        calls[0].state.memories.map((memory) => memory.id).sort(),
        [...baselineOrder].sort(),
      );

      const rerank = result.trace.lookups.rerank;
      assert.equal(rerank.enabled, true);
      assert.equal(rerank.applied, true);
      assert.equal(rerank.reason, "reranked");
      assert.deepEqual(rerank.rows.map((row) => row.id), expectedOrder);
      assert.deepEqual(rerank.rows.map((row) => row.score), [1.9, 0.2]);
      assert.deepEqual(
        rerank.scores.map((entry) => entry.id),
        baselineOrder,
      );
      assert.deepEqual(
        rerank.scores.map((entry) => entry.afterIndex),
        baselineOrder.map((id) => expectedOrder.indexOf(id)),
      );
      assert.deepEqual(
        result.trace.lookups.localMemories.includedRows.map((row) => row.id),
        expectedOrder,
      );
      const text = result.text;
      assert.match(text, /Write unit tests/);
      assert.match(text, /Always run the repository linter/);
      const preferredText = preferredId === "test-memory" ? "Write unit tests" : "Always run the repository linter";
      const otherText = preferredId === "test-memory" ? "Always run the repository linter" : "Write unit tests";
      assert.ok(text.indexOf(preferredText) < text.indexOf(otherText));
    } finally {
      cleanup();
    }
  });

  test("fails open to the fused order when the request fails", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withRerankFixture();
    try {
      insertMemories(db);
      const before = await assembleRecall({
        db,
        prompt: PROMPT,
        repository: "fixture-repo",
        config: { ...config, typesafe: { ...config.typesafe, enabled: false } },
        fetchImpl: async () => { throw new Error("should not be called"); },
      });
      const baseline = before.trace.lookups.localMemories.includedRows.map((row) => row.id);

      const result = await assembleRecall({
        db,
        prompt: PROMPT,
        repository: "fixture-repo",
        config,
        fetchImpl: async () => { throw new Error("socket hang up"); },
      });
      const rerank = result.trace.lookups.rerank;
      assert.equal(rerank.applied, false);
      assert.equal(rerank.reason, "request_failed");
      assert.match(rerank.error, /socket hang up/);
      assert.deepEqual(
        result.trace.lookups.localMemories.includedRows.map((row) => row.id),
        baseline,
      );
      assert.match(result.text, /Write unit tests/);
      assert.match(result.text, /Always run the repository linter/);
    } finally {
      cleanup();
    }
  });

  test("leaves recall untouched when no TypeSafe config is present", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { enabled: true, rollout: { memoryOperations: true, directives: true } },
    });
    try {
      insertMemories(db);
      let requested = false;
      const result = await assembleRecall({
        db,
        prompt: PROMPT,
        repository: "fixture-repo",
        config,
        fetchImpl: async () => {
          requested = true;
          throw new Error("should not be called");
        },
      });
      assert.equal(requested, false);
      assert.equal(result.trace.lookups.rerank.enabled, false);
      assert.equal(result.trace.lookups.rerank.reason, "typesafe_disabled");
    } finally {
      cleanup();
    }
  });
});
