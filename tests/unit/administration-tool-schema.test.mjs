import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryTools } from "../../lib/tools/memory-tools.mjs";
import { withFixtureDb } from "../helpers/fixture-db.mjs";
import { findTool } from "../helpers/tool-helpers.mjs";

function assertDeclaredApplyPayload(tool, payload) {
  const fields = tool.parameters.properties;
  for (const key of Object.keys(payload)) assert.ok(fields[key], `${tool.name} must advertise apply field ${key}`);
  assert.equal(fields.selectedCandidateIds.type, "array");
  assert.equal(fields.selectedCandidateIds.items.type, "string");
  assert.equal(fields.selectedCandidateIds.maxItems, 200);
  assert.equal(fields.limit.type, "integer");
  assert.equal(fields.limit.minimum, 1);
  assert.equal(fields.limit.maximum, 200);
  assert.equal(fields.limit.default, 50);
}

for (const operation of ["purge", "repair"]) {
  test(`registered memory_${operation} declares and accepts the exact preview-selected apply payload`, async () => {
    const f = await withFixtureDb();
    try {
      const repository = "github.com/example/schema";
      const id = f.db.insertSemanticMemory({ type: "user_preference", content: "Prefer copper schema fixtures.", repository, scope: "repo", sourceSessionId: "schema-session" });
      f.db.saveIngestionCheckpoint("codex", "schema-session", { repository, adapterState: { turns: [{ user_message: "Prefer copper schema fixtures." }] }, health: {} });
      const tool = findTool(createMemoryTools({ getRuntime: async () => ({ initialized: true, db: f.db, config: f.config }) }), `memory_${operation}`);
      const request = operation === "purge"
        ? { memoryIds: [id], includeDependentAggregates: true, limit: 200 }
        : { repositoryMappings: [{ legacy: repository, canonical: "github.com/example/renamed" }], limit: 200 };
      const plan = JSON.parse(await tool.handler(request, { sessionId: "caller" }));
      assert.equal(plan.unresolvedCandidates.length, 0);
      assert.ok(plan.candidateIds.length > 0);
      const payload = { ...request, action: "apply", planFingerprint: plan.planFingerprint, selectedCandidateIds: plan.candidateIds };
      assertDeclaredApplyPayload(tool, payload);
      const applied = JSON.parse(await tool.handler(payload, { sessionId: "caller" }));
      assert.equal(applied.applied, true);
      if (operation === "purge") assert.equal(f.db.getIngestionCheckpoint("codex", "schema-session"), null);
      else assert.equal(f.db.db.prepare("SELECT repository FROM semantic_memory WHERE id=?").get(id).repository, "github.com/example/renamed");
    } finally { f.cleanup(); }
  });
}
