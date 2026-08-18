/**
 * tests/unit/semantic-search.test.mjs
 *
 * Unit tests for lib/semantic-search.mjs.
 *
 * Covers:
 *   - cosineSimilarity: equal, orthogonal, and length-mismatched vectors.
 *   - semanticSearch enabled/disabled gating from config.
 *   - Ranking: a deterministic fake embeddings endpoint (bag-of-words
 *     vectors) must rank the most related memory first and report scores.
 *   - Lazy embedding cache: memory vectors are written to the side table and
 *     reused (second search does not re-embed memories).
 *   - Fail-open: endpoint errors return { enabled: false, rows: [] }.
 *
 * Run:
 *   node --test tests/unit/semantic-search.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { cosineSimilarity, semanticSearch, semanticSearchEnabled } from "../../lib/semantic-search.mjs";
import { freshDb } from "../helpers/fixture-db.mjs";
import { createTempHome } from "../helpers/temp-home.mjs";
import { buildFixtureConfig } from "../helpers/fixture-config.mjs";

// ---------------------------------------------------------------------------
// Deterministic fake embeddings endpoint.
//
// Embeds text as a bag-of-words vector over a tiny fixed vocabulary so cosine
// similarity reflects term overlap without any real model. Vectors are
// 4-dimensional; the first 3 dims are token presence for the vocabulary
// below, the 4th is a filler that is always 1.0 so identical texts score 1.0.
// ---------------------------------------------------------------------------

const VOCAB = ["auth", "login", "middleware", "router"];

function embedText(text) {
  const lower = String(text).toLowerCase();
  const vector = VOCAB.map((term) => (lower.includes(term) ? 1.0 : 0.0));
  // Synonym expansion: sign-in/login imply auth+login context, so the query
  // and the auth memory share dims even without literal term overlap.
  if (lower.includes("sign-in") || lower.includes("signin") || lower.includes("login")) {
    vector[VOCAB.indexOf("auth")] = 1.0;
    vector[VOCAB.indexOf("login")] = 1.0;
  }
  vector.push(1.0); // filler
  return vector;
}

function makeFakeFetch({ failEmbeddings = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.model !== "test-embedding-model") {
      throw new Error(`unexpected model: ${body.model}`);
    }
    calls.push({ url, input: body.input });
    if (failEmbeddings) {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
      };
    }
    const data = body.input.map((text, index) => ({
      index,
      embedding: embedText(text),
    }));
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { fetchImpl, calls };
}

function withSemanticConfig(db, overrides = {}) {
  return {
    ...db.config,
    localInference: {
      enabled: true,
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-chat-model",
      embeddings: {
        enabled: true,
        model: "test-embedding-model",
        maxInputs: 24,
        ...overrides,
      },
    },
  };
}

describe("cosineSimilarity", () => {
  test("returns 1.0 for identical vectors", () => {
    assert.strictEqual(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1.0);
  });

  test("returns 0 for orthogonal vectors", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 1e-9);
  });

  test("returns 0 for length-mismatched or empty inputs", () => {
    assert.strictEqual(cosineSimilarity([1, 2], [1, 2, 3]), 0);
    assert.strictEqual(cosineSimilarity([], []), 0);
    assert.strictEqual(cosineSimilarity(null, [1]), 0);
  });
});

describe("semanticSearchEnabled", () => {
  test("false when local inference is off", () => {
    assert.strictEqual(semanticSearchEnabled({ enabled: true }), false);
    assert.strictEqual(semanticSearchEnabled({ enabled: true, embeddings: { enabled: true, model: "" } }), false);
    assert.strictEqual(semanticSearchEnabled({ enabled: false, embeddings: { enabled: true, model: "m" } }), false);
  });

  test("true when embeddings are configured", () => {
    assert.strictEqual(
      semanticSearchEnabled({ enabled: true, embeddings: { enabled: true, model: "m" } }),
      true,
    );
  });
});

describe("semanticSearch", () => {
  test("returns enabled:false when embeddings are not configured", async () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = buildFixtureConfig(home);
      const db = freshDb(config);
      try {
        const result = await semanticSearch({ db, query: "anything" });
        assert.strictEqual(result.enabled, false);
        assert.deepEqual(result.rows, []);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  test("ranks the most related memory first using the fake endpoint", async () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = buildFixtureConfig(home);
      const db = freshDb(config);
      try {

        // Insert two memories: one clearly related to the query, one not.
        db.db.prepare(`
          INSERT INTO semantic_memory (id, type, content, confidence, repository, scope, tags, metadata_json, created_at, updated_at)
          VALUES (?, 'user_preference', ?, 0.9, NULL, 'global', '[]', '{}', ?, ?)
        `).run("mem-auth", "Authentication and login logic belong in the middleware layer.", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
        db.db.prepare(`
          INSERT INTO semantic_memory (id, type, content, confidence, repository, scope, tags, metadata_json, created_at, updated_at)
          VALUES (?, 'user_preference', ?, 0.9, NULL, 'global', '[]', '{}', ?, ?)
        `).run("mem-cats", "Cats are crepuscular and sleep most of the day.", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");

        const { fetchImpl, calls } = makeFakeFetch();
        const result = await semanticSearch({
          db,
          query: "how should I structure user sign-in?",
          fetchImpl,
          config: withSemanticConfig(db),
          limit: 5,
        });

        assert.strictEqual(result.enabled, true);
        assert.ok(result.rows.length >= 2, "both memories should be ranked");
        assert.strictEqual(result.rows[0].id, "mem-auth");
        assert.ok(result.rows[0].score > result.rows[1].score);
        // The query embed plus the lazy memory batch must have been requested.
        assert.strictEqual(calls.length, 2);
        assert.deepEqual(calls[0].input, ["how should I structure user sign-in?"]);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  test("caches memory vectors and reuses them on the second search", async () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = buildFixtureConfig(home);
      const db = freshDb(config);
      try {

        db.db.prepare(`
          INSERT INTO semantic_memory (id, type, content, confidence, repository, scope, tags, metadata_json, created_at, updated_at)
          VALUES (?, 'user_preference', ?, 0.9, NULL, 'global', '[]', '{}', ?, ?)
        `).run("mem-auth", "Authentication and login logic belong in the middleware layer.", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");

        const { fetchImpl, calls } = makeFakeFetch();
        const first = await semanticSearch({
          db,
          query: "sign-in flow",
          fetchImpl,
          config: withSemanticConfig(db),
        });
        assert.strictEqual(first.enabled, true);
        assert.strictEqual(calls.length, 2, "query + lazy memory embed on first search");

        const second = await semanticSearch({
          db,
          query: "sign-in flow again",
          fetchImpl,
          config: withSemanticConfig(db),
        });
        assert.strictEqual(second.enabled, true);
        assert.strictEqual(calls.length, 3, "only the query is re-embedded on cached searches");
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  test("fails open when the embeddings endpoint errors", async () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = buildFixtureConfig(home);
      const db = freshDb(config);
      try {

        db.db.prepare(`
          INSERT INTO semantic_memory (id, type, content, confidence, repository, scope, tags, metadata_json, created_at, updated_at)
          VALUES (?, 'user_preference', ?, 0.9, NULL, 'global', '[]', '{}', ?, ?)
        `).run("mem-auth", "Authentication and login logic belong in the middleware layer.", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");

        const { fetchImpl } = makeFakeFetch({ failEmbeddings: true });
        const result = await semanticSearch({
          db,
          query: "sign-in flow",
          fetchImpl,
          config: withSemanticConfig(db),
        });

        assert.strictEqual(result.enabled, false);
        assert.deepEqual(result.rows, []);
        assert.ok(typeof result.error === "string" && result.error.length > 0);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });
});
