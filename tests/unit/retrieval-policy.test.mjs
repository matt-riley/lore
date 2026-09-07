import assert from "node:assert/strict";
import { test } from "node:test";

import { withFixtureDb } from "../helpers/fixture-db.mjs";
import { mergeSemanticRecallResult } from "../../lib/memory/memory-operations.mjs";
import { extractMeaningfulPromptTerms, scorePromptFallbackRows } from "../../lib/context/prompt-search-query.mjs";
import { indexMemoryEmbeddings } from "../../lib/memory/semantic-search.mjs";

test("semantic retrieval enforces repository, expiry, and unknown-repository policy", async () => {
  const fixture = await withFixtureDb();
  try {
    fixture.db.insertSemanticMemory({ id: "global", type: "user_preference", content: "Global preference", scope: "global" });
    fixture.db.insertSemanticMemory({ id: "local", type: "user_preference", content: "Local preference", scope: "repo", repository: "repo/a" });
    fixture.db.insertSemanticMemory({ id: "foreign", type: "user_preference", content: "Foreign preference", scope: "repo", repository: "repo/b" });
    fixture.db.insertSemanticMemory({ id: "expired", type: "user_preference", content: "Expired preference", scope: "repo", repository: "repo/a", expiresAt: "2020-01-01T00:00:00.000Z" });
    assert.deepEqual(fixture.db.searchSemantic({ query: "", repository: "repo/a", now: "2025-01-01T00:00:00.000Z" }).map((row) => row.id), ["local", "global"]);
    assert.deepEqual(fixture.db.searchSemantic({ query: "", repository: null, now: "2025-01-01T00:00:00.000Z" }).map((row) => row.id), ["global"]);
    assert.deepEqual(fixture.db.searchSemantic({ query: "", repository: "repo/a", includeOtherRepositories: true, scopes: ["transferable"], now: "2025-01-01T00:00:00.000Z" }).map((row) => row.id), []);
  } finally {
    fixture.cleanup();
  }
});

test("prompt fallback scores meaningful terms without weakening strict search", () => {
  const terms = extractMeaningfulPromptTerms("How should helpers in checkout be structured?");
  assert.deepEqual(terms.sort(), ["checkout", "helpers", "structured"]);
  const rows = scorePromptFallbackRows([
    { id: "match", content: "Prefer small pure functions in checkout helpers." },
    { id: "irrelevant", content: "Penguin habitats need cold water." },
  ], terms);
  assert.deepEqual(rows.map((row) => row.id), ["match"]);
});

test("suppression fingerprints exclude a restored generated copy while manual restore remains visible", async () => {
  const fixture = await withFixtureDb();
  try {
    const oldId = fixture.db.insertSemanticMemory({ id: "old", type: "user_preference", content: "Prefer kiwi", repository: "repo/a", scope: "repo" });
    fixture.db.forgetMemory({ id: oldId });
    fixture.db.db.prepare(`
      INSERT INTO semantic_memory (id, type, content, confidence, repository, scope, tags, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, '[]', ?, ?, ?)
    `).run("generated-copy", "user_preference", "Prefer kiwi", "repo/a", "repo", JSON.stringify({}), new Date().toISOString(), new Date().toISOString());
    assert.deepEqual(fixture.db.searchSemantic({ query: "kiwi", repository: "repo/a" }), []);
    const manual = fixture.db.insertSemanticMemory({ type: "user_preference", content: "Prefer kiwi", repository: "repo/a", scope: "repo", metadata: { source: "memory_save" } });
    assert.deepEqual(fixture.db.searchSemantic({ query: "kiwi", repository: "repo/a" }).map((row) => row.id), [manual]);
  } finally {
    fixture.cleanup();
  }
});

test("maintenance indexing includes repository memories and advances after provider failure", async () => {
  const fixture = await withFixtureDb({ configOverrides: { localInference: { enabled: true, embeddings: { enabled: true, model: "test" } } } });
  try {
    fixture.db.insertSemanticMemory({ id: "repo-memory", type: "user_preference", content: "Repository memory", repository: "repo/a", scope: "repo" });
    const failed = await indexMemoryEmbeddings({ db: fixture.db, config: fixture.config, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    assert.equal(failed.failed, 1);
    assert.ok(failed.cursor > 0);
    const indexed = await indexMemoryEmbeddings({ db: fixture.db, config: fixture.config, fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: JSON.parse(options.body).input.map((_, index) => ({ index, embedding: [1, 0] })) }),
    }), cursor: failed.cursor });
    assert.equal(indexed.total, 1);
  } finally {
    fixture.cleanup();
  }
});

test("semantic recall merge keeps the final text and token estimate aligned", () => {
  const result = mergeSemanticRecallResult({
    result: { text: "## Context\n\n- Existing memory", trace: { output: {} } },
    semantic: { enabled: true, rows: [{ id: "semantic-1", type: "user_preference", content: "Prefer small pure functions.", score: 0.91 }] },
    config: { budgets: { total: 100 } },
  });
  assert.match(result.text, /Semantic Matches/);
  assert.equal(result.estimatedTokens, result.trace.output.estimatedTokens);
  assert.equal(result.semanticMatches.length, 1);
});

test("semantic merge accounts for heading overhead at a small total budget", () => {
  const result = mergeSemanticRecallResult({
    result: { text: "", trace: { output: {} } },
    semantic: { enabled: true, rows: [{ id: "too-large", type: "fact", content: "abcd", score: 1 }] },
    config: { budgets: { total: 5 } },
  });
  assert.equal(result.semanticMatches.length, 0);
  assert.equal(result.trace.omissions[0].reason, "budget");
  assert.equal(result.estimatedTokens, 0);
});
