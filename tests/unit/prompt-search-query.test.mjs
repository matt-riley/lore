import assert from "node:assert/strict";
import { test } from "node:test";
import { withFixtureDb } from "../helpers/fixture-db.mjs";

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
    assert.deepEqual(f.db.searchSemantic({ query: "Remind me what we decided about Redis retries", repository: "team/current" }), []);
  } finally { f.cleanup(); }
});


test("prompt recall does not require every alias to appear in a matching memory", async () => {
  const f = await withFixtureDb();
  try {
    const id = f.db.insertSemanticMemory({ type: "user_preference", content: "Deployment rollback restores the previous immutable image.", repository: "team/current", scope: "repo" });
    assert.deepEqual(f.db.buildPromptSemanticContext({ prompt: "deployment rollback", repository: "team/current", limit: 6 }).memories.map(row => row.id), [id]);
  } finally { f.cleanup(); }
});
