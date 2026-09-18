import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assembleRecall } from "../../lib/context/recall-assembler.mjs";
import { FEATURE_PROMPT_VERSION } from "../../lib/inference/typesafe-features.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

const KEY = "directive-feature-key";
// Assembled at runtime so secret scanners never match a literal key here.
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

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
      insertDirective(db, "secret-ish", `For any project, the deploy key is ${AWS_KEY}.`);
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
      // The row stays in the section, but its content never reaches the model:
      // keeping it away from TypeSafe is only half the gate.
      assert.match(result.text, /deploy key is \[redacted\]/);
      assert.equal(result.text.includes(AWS_KEY), false);
    } finally {
      cleanup();
    }
  });

  test("keeps non-directive rows even when durability is low", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "junk", "For any project, there should be a live Env key.");
      db.insertSemanticMemory({
        id: "standing-rejection",
        type: "rejected_approach",
        content: "For any project, never force-push to a shared branch.",
        repository: "fixture-repo",
        scope: "repo",
        metadata: { source: "rule_extractor", confidenceBasis: "explicit_rejection_sentence" },
        confidence: 1,
        tags: ["rejected", "user"],
      });

      const { fetchImpl } = durabilityFetch({ junk: 0.1, "standing-rejection": 0.2 });
      const result = await assembleRecall({
        db,
        prompt: "Fix the config loader",
        repository: "fixture-repo",
        config,
        fetchImpl,
      });

      assert.doesNotMatch(result.text, /live Env key/);
      assert.match(result.text, /never force-push to a shared branch/);
    } finally {
      cleanup();
    }
  });

  test("re-scores rows written by an older prompt version", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "stale", "For any project, there should be a live Env key.");
      db.setSemanticMemoryMetadata("stale", {
        typesafe: { durability: 0.99, specificity: 1, model: "jev-1.13.0", scoredAt: "2026-01-01T00:00:00.000Z" },
      });

      const { fetchImpl, calls } = durabilityFetch({ stale: 0.1 });
      const result = await assembleRecall({
        db,
        prompt: "Fix the config loader",
        repository: "fixture-repo",
        config,
        fetchImpl,
      });

      assert.equal(calls.length, 1, "a versionless stored score must be re-judged");
      assert.doesNotMatch(result.text, /live Env key/);
    } finally {
      cleanup();
    }
  });

  test("survives a failing feature write", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "one-off", "For any project, there should be a live Env key.");
      const originalWrite = db.setSemanticMemoryMetadata.bind(db);
      db.setSemanticMemoryMetadata = () => {
        throw new Error("database is locked");
      };
      try {
        const { fetchImpl } = durabilityFetch({ "one-off": 0.1 });
        const result = await assembleRecall({
          db,
          prompt: "Fix the config loader",
          repository: "fixture-repo",
          config,
          fetchImpl,
        });
        // Persisting is an optimisation: a locked store must not fail recall,
        // and the judgment still applies to this run.
        assert.doesNotMatch(result.text, /live Env key/);
        assert.equal(result.trace.lookups.directives.durability.persistFailures, 1);
      } finally {
        db.setSemanticMemoryMetadata = originalWrite;
      }
    } finally {
      cleanup();
    }
  });

  test("still applies stored judgments when a later scoring run fails", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "one-off", "For any project, there should be a live Env key.");
      insertDirective(db, "unscored", "For any project, always use plain ESM.");
      db.setSemanticMemoryMetadata("one-off", {
        typesafe: {
          durability: 0.1,
          specificity: 1,
          model: "jev-1.13.0",
          promptVersion: FEATURE_PROMPT_VERSION,
          scoredAt: new Date().toISOString(),
        },
      });

      const result = await assembleRecall({
        db,
        prompt: "Fix the config loader",
        repository: "fixture-repo",
        config,
        fetchImpl: async () => ({ ok: false, status: 429, text: async () => "rate limited" }),
      });

      assert.doesNotMatch(result.text, /live Env key/);
      assert.match(result.text, /always use plain ESM/);
      const durability = result.trace.lookups.directives.durability;
      assert.match(durability.reason, /scoring_request_failed/);
      assert.equal(durability.dropped, 1);
    } finally {
      cleanup();
    }
  });

  test("scores directives only", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "directive-row", "For any project, always use plain ESM.");
      db.insertSemanticMemory({
        id: "preference-row",
        type: "user_preference",
        content: "For any project, prefer small pure functions.",
        repository: "fixture-repo",
        scope: "repo",
        metadata: { source: "rule_extractor", confidenceBasis: "standing_policy_sentence" },
        confidence: 1,
        tags: ["preference", "user"],
      });

      const { fetchImpl, calls } = durabilityFetch({ "directive-row": 0.9 });
      await assembleRecall({ db, prompt: "Fix the config loader", repository: "fixture-repo", config, fetchImpl });
      assert.deepEqual(calls[0].state.memories.map((memory) => memory.id), ["directive-row"]);
    } finally {
      cleanup();
    }
  });

  test("does not touch updated_at when persisting features", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      insertDirective(db, "stable", "For any project, always use plain ESM.");
      const before = db.searchSemantic({ query: "", types: ["directive"], limit: 5 })
        .find((row) => row.id === "stable").updated_at;

      const { fetchImpl } = durabilityFetch({ stable: 0.9 });
      await assembleRecall({ db, prompt: "Fix the config loader", repository: "fixture-repo", config, fetchImpl });

      const after = db.searchSemantic({ query: "", types: ["directive"], limit: 5 })
        .find((row) => row.id === "stable");
      assert.equal(after.updated_at, before, "annotating a row must not re-rank its recency");
      assert.equal(after.metadata.typesafe.durability, 0.9);
    } finally {
      cleanup();
    }
  });

  test("renders the same six directives when the feature is off", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withDirectiveFixture();
    try {
      for (let index = 0; index < 10; index += 1) {
        insertDirective(db, `directive-${index}`, `For any project, standard number ${index} applies.`);
      }
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

      const eligible = db.searchSemantic({ query: "", repository: "fixture-repo", types: ["directive"], limit: 50 })
        .filter((row) => row.id.startsWith("directive-"))
        .slice(0, 6)
        .map((row) => row.id);
      const rendered = result.trace.lookups.directives.includedRows.map((row) => row.id);
      assert.deepEqual(rendered, eligible);
      assert.equal(requested, false);
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
