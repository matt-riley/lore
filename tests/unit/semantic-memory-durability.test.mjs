import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

describe("LoreDb semantic memory durability verification", () => {
  test("insertSemanticMemory returns an id that is durably visible via an independent connection", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();

    try {
      const id = db.insertSemanticMemory({
        type: "user_preference",
        content: "Durability smoke test memory.",
        scope: "global",
        confidence: 1,
        tags: [],
      });

      assert.ok(id, "expected insertSemanticMemory to return a truthy id");
      // Should not throw: the row genuinely exists and is visible from a
      // brand-new connection, not just the writer's own cached connection.
      assert.doesNotThrow(() => db.verifySemanticMemoryDurability(id));
    } finally {
      cleanup();
    }
  });

  test("verifySemanticMemoryDurability throws when the id is not durably visible", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();

    try {
      assert.throws(
        () => db.verifySemanticMemoryDurability("id-that-was-never-inserted"),
        /did not durably persist/,
      );
    } finally {
      cleanup();
    }
  });

  test("upsert paths (manual and scoped matches) still pass durability verification", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();

    try {
      const firstId = db.insertSemanticMemory({
        type: "user_preference",
        content: "Repeated preference for dedup testing.",
        scope: "global",
        confidence: 0.8,
        tags: ["dedup"],
      });

      // Same type/content/scope should hit the scoped-match upsert path
      // (existing.id branch) rather than inserting a new row - this must
      // still pass durability verification using the existing row's id.
      const secondId = db.insertSemanticMemory({
        type: "user_preference",
        content: "Repeated preference for dedup testing.",
        scope: "global",
        confidence: 0.95,
        tags: ["dedup"],
      });

      assert.equal(secondId, firstId, "expected the scoped upsert to reuse the existing row's id");
      assert.doesNotThrow(() => db.verifySemanticMemoryDurability(secondId));
    } finally {
      cleanup();
    }
  });
});
