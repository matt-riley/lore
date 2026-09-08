import assert from "node:assert/strict";
import { test } from "node:test";
import { withFixtureDb } from "../helpers/fixture-db.mjs";
import { expandPromptSearchTerms, extractMeaningfulPromptTerms, scorePromptFallbackRows } from "../../lib/context/prompt-search-query.mjs";

test("prompt recall drops conversational scaffolding while preserving scope and exclusions", async () => {
  const f = await withFixtureDb();
  try {
    const id = f.db.insertSemanticMemory({ type: "user_preference", content: "Redis retries use exponential backoff.", repository: "team/current", scope: "repo" });
    const foreign = f.db.insertSemanticMemory({ type: "user_preference", content: "Redis retries use immediate retries.", repository: "team/other", scope: "repo" });
    const old = f.db.insertSemanticMemory({ type: "user_preference", content: "Redis retries use a constant delay.", repository: "team/current", scope: "repo" });
    f.db.forgetMemory({ id: old, supersededBy: id });
    const result = f.db.buildPromptSemanticContext({ prompt: "Remind me what we decided about Redis retries", repository: "team/current", limit: 6 });
    assert.deepEqual(result.memories.map(row => row.id), [id]);
    assert.ok(!result.memories.some(row => [foreign, old].includes(row.id)));
    for (const prompt of ["What did we decide?", "What about penguin habitats?"]) {
      assert.deepEqual(f.db.buildPromptSemanticContext({ prompt, repository: "team/current", limit: 6 }).memories, []);
    }
    assert.deepEqual(
      f.db.searchSemantic({ query: "Remind me what we decided about Redis retries", repository: "team/current" }).map((row) => row.id),
      [id],
    );
  } finally { f.cleanup(); }
});


test("prompt recall does not require every alias to appear in a matching memory", async () => {
  const f = await withFixtureDb();
  try {
    const id = f.db.insertSemanticMemory({ type: "user_preference", content: "Deployment rollback restores the previous immutable image.", repository: "team/current", scope: "repo" });
    assert.deepEqual(f.db.buildPromptSemanticContext({ prompt: "deployment rollback", repository: "team/current", limit: 6 }).memories.map(row => row.id), [id]);
  } finally { f.cleanup(); }
});

test("prompt fallback reaches older FTS matches beyond the bounded recent corpus slice", async () => {
  const f = await withFixtureDb();
  try {
    const older = f.db.insertSemanticMemory({
      id: "older-deployment-memory",
      type: "user_preference",
      content: "Deployment rollback restores the previous immutable image.",
      repository: "team/current",
      scope: "repo",
    });
    for (let index = 0; index < 140; index += 1) {
      f.db.insertSemanticMemory({
        id: `unrelated-${index}`,
        type: "user_preference",
        content: `Unrelated archive note ${index}.`,
        repository: "team/current",
        scope: "repo",
      });
    }
    const rows = f.db.searchPromptSemanticFallback({
      prompt: "What do we do about deployment rollbacks?",
      repository: "team/current",
      types: ["user_preference"],
      limit: 6,
    });
    assert.deepEqual(rows.map((row) => row.id), [older]);
  } finally { f.cleanup(); }
});

test("prompt fallback requires a meaningful match and excludes same-session and global cohabitants", async () => {
  const f = await withFixtureDb();
  try {
    const match = f.db.insertSemanticMemory({
      id: "matching-retries-memory",
      type: "user_preference",
      content: "Payment retries use exponential backoff.",
      repository: "team/current",
      scope: "repo",
      sourceSessionId: "shared-session",
    });
    const sibling = f.db.insertSemanticMemory({
      id: "unrelated-sibling-memory",
      type: "user_preference",
      content: "The unrelated sibling note discusses release colours.",
      repository: "team/current",
      scope: "repo",
      sourceSessionId: "shared-session",
    });
    const global = f.db.insertSemanticMemory({
      id: "unrelated-global-memory",
      type: "user_preference",
      content: "A completely unrelated global note discusses gardening.",
      scope: "global",
    });
    const rows = f.db.searchPromptSemanticFallback({
      prompt: "How should payment retry work?",
      repository: "team/current",
      types: ["user_preference"],
      limit: 6,
    });
    assert.deepEqual(rows.map((row) => row.id), [match]);
    assert.ok(!rows.some((row) => [sibling, global].includes(row.id)));
  } finally { f.cleanup(); }
});

test("prompt fallback augments a partial strict match with other scored propositions", async () => {
  const f = await withFixtureDb();
  try {
    const first = f.db.insertSemanticMemory({
      id: "strict-payment-memory",
      type: "user_preference",
      content: "What is the payment retries rule? Payment retries use exponential backoff.",
      repository: "team/current",
      scope: "repo",
    });
    const second = f.db.insertSemanticMemory({
      id: "fallback-payment-memory",
      type: "rejected_approach",
      content: "Payment retries must not hide changed payload.",
      repository: "team/current",
      scope: "repo",
    });
    assert.deepEqual(f.db.searchPromptSemanticRows({
      query: "What is the payment retries rule?",
      repository: "team/current",
      types: ["user_preference", "rejected_approach"],
      limit: 6,
    }).map((row) => row.id), [first]);
    const result = f.db.buildPromptSemanticContext({
      prompt: "What is the payment retries rule?",
      repository: "team/current",
      limit: 6,
    });
    assert.deepEqual(new Set(result.memories.map((row) => row.id)), new Set([first, second]));
  } finally { f.cleanup(); }
});

test("prompt terms retain meaningful uppercase acronyms", () => {
  const terms = extractMeaningfulPromptTerms("How does the CSV importer handle TLS encoding errors?");
  assert.ok(terms.includes("csv"));
  assert.ok(terms.includes("tls"));
});

test("prompt terms retain lowercase three-letter technical identifiers", () => {
  const terms = extractMeaningfulPromptTerms("How should jwt, sql, and api identifiers interact?");
  assert.ok(terms.includes("jwt"));
  assert.ok(terms.includes("sql"));
  assert.ok(terms.includes("api"));
});

test("prompt fallback splits compound terms like the FTS tokenizer", () => {
  const terms = expandPromptSearchTerms(["rate-limit"], { maxTerms: 1, maxVariants: 8 });
  assert.deepEqual(terms.slice(0, 3), ["rate-limit", "rate", "limit"]);
  const rows = scorePromptFallbackRows([
    { id: "rate-limit", content: "Key rate limits by account rather than IP." },
  ], ["rate-limit"]);
  assert.deepEqual(rows.map((row) => row.id), ["rate-limit"]);
});

test("prompt fallback recognizes safe paginate and pagination morphology", () => {
  const terms = expandPromptSearchTerms(["pagination"], { maxTerms: 1, maxVariants: 8 });
  assert.ok(terms.includes("paginate"));
  const rows = scorePromptFallbackRows([
    { id: "paginate", content: "The list endpoint should paginate with an opaque cursor." },
  ], ["pagination"]);
  assert.deepEqual(rows.map((row) => row.id), ["paginate"]);
});

test("preserves exact plural and technical spellings alongside morphological variants", () => {
  const variants = expandPromptSearchTerms(["status", "postgres"], { maxTerms: 2, maxVariants: 16 });
  assert.ok(variants.includes("status"));
  assert.ok(variants.includes("postgres"));
  assert.deepEqual(scorePromptFallbackRows([
    { id: "technical", content: "Status reports use Postgres for the release." },
  ], ["status", "postgres"]).map((row) => row.id), ["technical"]);
});
