import assert from "node:assert/strict";
import { test } from "node:test";

import { withFixtureDb } from "../helpers/fixture-db.mjs";
import { mergeSemanticRecallResult } from "../../lib/memory/memory-operations.mjs";
import { extractMeaningfulPromptTerms, scorePromptFallbackRows } from "../../lib/context/prompt-search-query.mjs";
import { buildSemanticEligibilitySql } from "../../lib/db/db-retrieval-policy.mjs";
import { embeddingContentHash, indexMemoryEmbeddings, semanticSearch, validatedCachedEmbeddingVector } from "../../lib/memory/semantic-search.mjs";
import { estimateTokens } from "../../lib/utils/token-estimator.mjs";

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

test("validated embedding cache helper rejects stale identity metadata", () => {
  const key = { content: "bounded retrieval", provider: "local", model: "embed-v1", dimensions: 2 };
  const row = { content_hash: embeddingContentHash(key.content), provider: key.provider, model: key.model, dimensions: 2, vector: "[1,0]" };
  assert.deepEqual(validatedCachedEmbeddingVector(row, key), [1, 0]);
  assert.equal(validatedCachedEmbeddingVector({ ...row, model: "embed-v2" }, key), null);
  assert.equal(validatedCachedEmbeddingVector({ ...row, vector: "[0,0]" }, key), null);
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

test("recall budgets preserve the rendered commitment heading as required context", () => {
  const commitments = "## Relevant Commitments, Preferences, And Identity\n\n- Keep repository guidance visible.";
  const result = mergeSemanticRecallResult({
    result: {
      text: `## Optional\n\n- Unrelated context.\n\n${commitments}`,
      trace: { output: {} },
    },
    semantic: { enabled: true, rows: [] },
    config: { budgets: { total: estimateTokens(commitments) } },
  });
  assert.match(result.text, /## Relevant Commitments, Preferences, And Identity/);
  assert.doesNotMatch(result.text, /## Optional/);
});

test("semantic merge deduplicates only rows that were actually rendered", () => {
  const result = mergeSemanticRecallResult({
    result: {
      text: "## Context\n\n- Rendered memory",
      trace: { lookups: { local: { rows: [{ id: "same", content: "Omitted lexical memory" }], includedRows: [] } }, output: {} },
    },
    semantic: { enabled: true, rows: [{ id: "same", type: "fact", content: "Omitted lexical memory", score: 0.8 }] },
    config: { budgets: { total: 100 } },
  });
  assert.equal(result.semanticMatches.length, 1);
  assert.deepEqual(result.trace.lookups.semantic.includedRows.map((row) => row.id), ["same"]);
});

test("embedding candidate pages advance by a stable keyset cursor", async () => {
  const fixture = await withFixtureDb();
  try {
    for (let index = 0; index < 260; index += 1) {
      fixture.db.insertSemanticMemory({ id: `keyset-${String(index).padStart(3, "0")}`, type: "user_preference", content: `Keyset candidate ${index}`, scope: "global" });
    }
    fixture.db.ensureMemoryEmbeddingTable();
    const first = fixture.db.listSemanticMemoriesForEmbedding({ limit: 256 });
    const cursor = { memoryRowid: first.at(-1).memory_rowid };
    const second = fixture.db.listSemanticMemoriesForEmbedding({ limit: 256, after: cursor });
    assert.equal(first.length, 256);
    assert.equal(second.length, 4);
    assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 260);
  } finally {
    fixture.cleanup();
  }
});

test("deadline failures return sorted partial semantic rows with diagnostics", async () => {
  const fixture = await withFixtureDb({ configOverrides: { localInference: { enabled: true, embeddings: { enabled: true, model: "test" } } } });
  try {
    const rows = Array.from({ length: 256 }, (_, index) => ({
      id: `partial-${String(index).padStart(3, "0")}`,
      type: "user_preference",
      content: `Partial candidate ${index}`,
      repository: null,
      scope: "global",
      scope_source: "auto",
      updated_at: `2024-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      expires_at: null,
      metadata_json: "{}",
      embedding_updated_at: "2024-01-01T00:00:00.000Z",
      vector: JSON.stringify([1, 0]),
      content_hash: "stale",
      provider: "test",
      model: "test",
      dimensions: 2,
    }));
    let calls = 0;
    fixture.db.listSemanticMemoriesForEmbedding = () => {
      calls += 1;
      if (calls > 1) throw new Error("deadline exceeded while paging");
      return rows;
    };
    fixture.db.ensureMemoryEmbeddingTable = () => {};
    const result = await semanticSearch({
      db: fixture.db,
      query: "partial",
      deadlineMs: 10_000,
      fetchImpl: async (_url, options) => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }),
      }),
      config: fixture.config,
    });
    assert.equal(result.diagnostics.partialCoverage, true);
    assert.ok(result.error);
    assert.ok(result.rows.length > 0);
    assert.ok(result.rows.every((row, index) => index === 0 || row.score <= result.rows[index - 1].score));
  } finally {
    fixture.cleanup();
  }
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

test("semantic merge applies the final total budget to the base sections", () => {
  const result = mergeSemanticRecallResult({
    result: {
      text: "## Context\n\n- This base section is deliberately much longer than the output budget allows.",
      trace: { output: {}, lookups: {} },
    },
    semantic: { enabled: true, rows: [] },
    config: { budgets: { total: 5 } },
  });
  assert.ok(result.estimatedTokens <= 5);
  assert.equal(result.estimatedTokens, result.trace.output.estimatedTokens);
});

test("maintenance advances past persistently malformed vectors within a short final page", async () => {
  const fixture = await withFixtureDb({ configOverrides: { localInference: { enabled: true, embeddings: { enabled: true, model: "test" } } } });
  try {
    for (let n = 0; n < 4; n += 1) fixture.db.insertSemanticMemory({ id: `fair-${n}`, type: "user_preference", content: `Prefer queue${n} records.`, repository: "repo/a", scope: "repo" });
    const visited = new Set();
    let cursor = 0;
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await indexMemoryEmbeddings({ db: fixture.db, config: fixture.config, cursor, maxMemories: 1, fetchImpl: async (_url, options) => {
        const input = JSON.parse(options.body).input;
        input.forEach((text) => visited.add(text));
        return { ok: true, status: 200, json: async () => ({ data: input.map((_, index) => ({ index, embedding: [] })) }) };
      } });
      cursor = result.cursor;
    }
    assert.equal(visited.size, 4);
  } finally { fixture.cleanup(); }
});

test("vector candidates include authority metadata and suppress changed-content canonical restores in SQL", async () => {
  const fixture = await withFixtureDb();
  try {
    fixture.db.insertSemanticMemory({ id: "old-canonical", type: "user_preference", content: "Prefer quartz queues.", repository: "repo/a", scope: "repo" });
    fixture.db.db.prepare("UPDATE semantic_memory SET canonical_key = 'queue-policy' WHERE id = 'old-canonical'").run();
    fixture.db.forgetMemory({ id: "old-canonical" });
    fixture.db.db.prepare(`INSERT INTO semantic_memory(id,type,content,scope,repository,canonical_key,metadata_json,created_at,updated_at)
      SELECT 'restored-canonical',type,'Prefer changed quartz queues.',scope,repository,canonical_key,metadata_json,created_at,updated_at FROM semantic_memory WHERE id='old-canonical'`).run();
    fixture.db.insertSemanticMemory({ id: "manual-canonical", type: "user_preference", content: "Prefer quartz queues.", scope: "repo", repository: "repo/a", metadata: { source: "memory_save" } });
    fixture.db.listActiveMemorySuppressions = () => { throw new Error("retrieval must not load the entire suppression ledger"); };
    assert.deepEqual(fixture.db.searchSemantic({ query: "quartz", repository: "repo/a" }).map((row) => row.id), ["manual-canonical"]);
    const candidates = fixture.db.listSemanticMemoriesForEmbedding({ repository: "repo/a" });
    assert.deepEqual(candidates.map((row) => row.id), ["manual-canonical"]);
    assert.equal(JSON.parse(candidates[0].metadata_json).source, "memory_save");
  } finally { fixture.cleanup(); }
});

test("transferable vector fallback keeps local and global context while excluding private foreign rows", async () => {
  const fixture = await withFixtureDb();
  try {
    for (const [id, scope, repository] of [["local", "repo", "repo/a"], ["global", "global", null], ["foreign-private", "repo", "repo/b"], ["foreign-shared", "transferable", "repo/b"]]) {
      fixture.db.insertSemanticMemory({ id, type: "user_preference", content: `Prefer ${id} fixtures.`, scope, repository, metadata: { source: "memory_save" } });
    }
    assert.deepEqual(fixture.db.listSemanticMemoriesForEmbedding({ repository: "repo/a", includeOtherRepositories: true, transferableFallback: true }).map((row) => row.id).sort(), ["foreign-shared", "global", "local"]);
    assert.deepEqual(fixture.db.listSemanticMemoriesForEmbedding({ repository: null, includeOtherRepositories: true, transferableFallback: true }).map((row) => row.id), ["global"]);
  } finally { fixture.cleanup(); }
});

test("public expiry timestamps normalize for SQL reads and inferred repeats preserve manual expiry", async () => {
  const fixture = await withFixtureDb();
  try {
    const id = fixture.db.insertSemanticMemory({ id: "expiry-policy", type: "user_preference", content: "Prefer expiry fixtures.", scope: "repo", repository: "repo/a", expiresAt: "September 8, 2035 12:00:00 GMT", metadata: { source: "memory_save" } });
    assert.deepEqual(fixture.db.searchSemantic({ query: "expiry", repository: "repo/a", now: "2030-01-01" }).map((row) => row.id), [id]);
    const expiry = fixture.db.getSemanticMemoryByIds([id])[0].expires_at;
    fixture.db.insertSemanticMemory({ type: "user_preference", content: "Prefer expiry fixtures.", scope: "repo", repository: "repo/a", expiresAt: null });
    assert.equal(fixture.db.getSemanticMemoryByIds([id])[0].expires_at, expiry);
  } finally { fixture.cleanup(); }
});


test("suppression eligibility uses indexed lookups before limiting candidates", async () => {
  const fixture = await withFixtureDb();
  try {
    fixture.db.ensureOpen();
    const policy = buildSemanticEligibilitySql({ repository: "repo/a" });
    const plan = fixture.db.db.prepare(`EXPLAIN QUERY PLAN SELECT sm.id FROM semantic_memory sm WHERE ${policy.sql} LIMIT 8`).all(...policy.params);
    const suppressionSteps = plan.filter((row) => row.detail.includes("policy_ms"));
    assert.equal(suppressionSteps.length, 3);
    assert.ok(suppressionSteps.every((row) => /SEARCH policy_ms USING/.test(row.detail)), JSON.stringify(suppressionSteps));
  } finally { fixture.cleanup(); }
});
