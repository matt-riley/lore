import assert from "node:assert/strict";
import { test } from "node:test";
import { withFixtureDb } from "../helpers/fixture-db.mjs";
import { recallMemory } from "../../lib/memory/memory-operations.mjs";

test("explicitly relevant style memories remain searchable when ambient persona is disabled", async () => {
  const { db, cleanup } = await withFixtureDb({ configOverrides: { rollout: { ambientPersona: false, memoryOperations: true } } });
  try {
    const content = "Use a calm, direct tone for difficult status updates in every repository.";
    db.insertSemanticMemory({ type: "user_preference", content, scope: "global", metadata: { source: "memory_save" } });
    const result = recallMemory({ db, repository: "fixture/repo", prompt: "What tone should difficult status updates use?" });
    assert.ok(result.text.includes(content));
    const unrelated = recallMemory({ db, repository: "fixture/repo", prompt: "How does the checksum verifier parse uploaded archives?" });
    assert.equal(unrelated.text.includes(content), false);
  } finally { cleanup(); }
});
