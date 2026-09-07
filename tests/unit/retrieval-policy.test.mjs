import assert from "node:assert/strict";
import { test } from "node:test";

import { withFixtureDb } from "../helpers/fixture-db.mjs";
import { mergeSemanticRecallResult } from "../../lib/memory/memory-operations.mjs";
import { extractMeaningfulPromptTerms, scorePromptFallbackRows } from "../../lib/context/prompt-search-query.mjs";

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
