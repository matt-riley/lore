import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assembleRecall } from "../../lib/context/recall-assembler.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

const KEY = "directive-feature-key";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Answer each durability question from a map of memory id -> probability. */
function durabilityFetch(durabilities, calls = []) {
  const fetchImpl = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body));
    calls.push(body);
    const answers = {};
    body.state.memories.forEach((memory, index) => {
      answers[`durable_${index}`] = { type: "noul", noul: durabilities[memory.id] ?? 0.9 };
      answers[`specific_${index}`] = { type: "score", score: 1.2, confidence: 0.8 };
    });
    return jsonResponse({ model: "jev-latest", answers, usage: { input_tokens: 100, output_tokens: 12 } });
  };
  return { fetchImpl, calls };
}

async function withDirectiveFixture() {
  return withFixtureDb({
    configOverrides: {
      enabled: true,
      rollout: { memoryOperations: true, directives: true },
      typesafe: {
        enabled: true,
        model: "jev-latest",
        timeoutMs: 1000,
        apiKey: KEY,
        features: { enabled: true, minDurability: 0.5, maxMemoriesPerRun: 8 },
      },
    },
  });
}

function insertDirective(db, id, content) {
  db.insertSemanticMemory({
    id,
    type: "directive",
    content,
    scope: "global",
    metadata: { source: "rule_extractor", confidenceBasis: "standing_policy_sentence" },
    confidence: 0.9,
    tags: ["directive", "policy"],
  });
}

describe("TypeSafe directive durability filtering", () => {
  test("drops one-off statements, keeps durable rules and persists the features", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "one-off", "For any project, there should be a live Env key.");
      insertDirective(db, "durable", "For any project, always use plain ESM.");

      const { fetchImpl, calls } = durabilityFetch({ "one-off": 0.14, durable: 0.9 });
      const result = await assembleRecall({
        db,
        prompt: "Fix the config loader",
        repository: "fixture-repo",
        config,
        fetchImpl,
      });

      assert.equal(calls.length, 1);
      assert.match(result.text, /always use plain ESM/);
      assert.doesNotMatch(result.text, /live Env key/);

      const durability = result.trace.lookups.directives.durability;
      assert.equal(durability.enabled, true);
      assert.equal(durability.reason, "durability_filtered");
      assert.equal(durability.scored, 2);
      assert.equal(durability.dropped, 1);
      assert.equal(durability.threshold, 0.5);

      // Features are persisted on the row so the judgment is made once.
      const oneOff = db.searchSemantic({ query: "", types: ["directive"], limit: 10 })
        .find((row) => row.id === "one-off");
      assert.equal(oneOff.metadata.typesafe.durability, 0.14);
      assert.equal(oneOff.metadata.typesafe.model, "jev-latest");
      assert.equal(oneOff.metadata.typesafe.specificity, 1.2);
    } finally {
      cleanup();
    }
  });

  test("reuses stored features instead of calling the provider again", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "durable", "For any project, always use plain ESM.");
      insertDirective(db, "one-off", "For any project, there should be a live Env key.");

      const first = durabilityFetch({ "one-off": 0.14, durable: 0.9 });
      await assembleRecall({ db, prompt: "Fix the config loader", repository: "fixture-repo", config, fetchImpl: first.fetchImpl });
      assert.equal(first.calls.length, 1);

      const second = durabilityFetch({}, []);
      const result = await assembleRecall({ db, prompt: "Fix the config loader", repository: "fixture-repo", config, fetchImpl: second.fetchImpl });
      assert.equal(second.calls.length, 0, "second recall must not re-score cached features");
      assert.doesNotMatch(result.text, /live Env key/);
      assert.match(result.text, /always use plain ESM/);
    } finally {
      cleanup();
    }
  });

  test("fails open when scoring fails", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "one-off", "For any project, there should be a live Env key.");
      insertDirective(db, "durable", "For any project, always use plain ESM.");

      const result = await assembleRecall({
        db,
        prompt: "Fix the config loader",
        repository: "fixture-repo",
        config,
        fetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
      });

      assert.match(result.text, /live Env key/);
      assert.match(result.text, /always use plain ESM/);
      const durability = result.trace.lookups.directives.durability;
      assert.equal(durability.enabled, true);
      assert.match(durability.reason, /scoring_request_failed/);
      assert.equal(durability.dropped, 0);
    } finally {
      cleanup();
    }
  });

  test("never sends sensitive directive content to the provider", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "secret-ish", "For any project, the deploy key is AKIAIOSFODNN7EXAMPLE.");
      insertDirective(db, "durable", "For any project, always use plain ESM.");

      const { fetchImpl, calls } = durabilityFetch({ durable: 0.9 });
      const result = await assembleRecall({
        db,
        prompt: "Fix the config loader",
        repository: "fixture-repo",
        config,
        fetchImpl,
      });

      assert.deepEqual(calls[0].state.memories.map((memory) => memory.id), ["durable"]);
      assert.equal(result.trace.lookups.directives.durability.withheldSensitive, 1);
      assert.match(result.text, /AKIAIOSFODNN7EXAMPLE/);
    } finally {
      cleanup();
    }
  });

  test("does nothing when the features switch is off", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "one-off", "For any project, there should be a live Env key.");
      const disabled = {
        ...config,
        typesafe: { ...config.typesafe, features: { ...config.typesafe.features, enabled: false } },
      };
      let requested = false;
      const result = await assembleRecall({
        db,
        prompt: "Fix the config loader",
        repository: "fixture-repo",
        config: disabled,
        fetchImpl: async () => {
          requested = true;
          throw new Error("should not be called");
        },
      });
      assert.equal(requested, false);
      assert.match(result.text, /live Env key/);
      assert.equal(result.trace.lookups.directives.durability.enabled, false);
      assert.equal(result.trace.lookups.directives.durability.reason, "features_disabled");
    } finally {
      cleanup();
    }
  });
});
