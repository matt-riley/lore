import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { freshDb, FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";
import { enabledConfig } from "../helpers/fixture-config.mjs";

test("capture transactions check durability after commit and roll back a failed replacement", { skip: !FTS5_AVAILABLE }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-capture-transaction-"));
  const db = freshDb(enabledConfig(home));
  try {
    const calls = [];
    const verify = db.verifySemanticMemoryDurability.bind(db);
    db.verifySemanticMemoryDurability = (id) => { calls.push(id); verify(id); };
    const memory = { type: "user_preference", content: "I prefer focused tests", sourceSessionId: "claude:fixture", repository: "owner/repo" };
    let id;
    db.withSemanticMemoryTransaction(() => {
      id = db.insertSemanticMemory(memory);
      assert.equal(calls.length, 0);
    });
    assert.deepEqual(calls, [id]);
    const before = db.db.prepare("SELECT * FROM semantic_memory WHERE id = ?").get(id);
    assert.throws(() => db.withSemanticMemoryTransaction(() => {
      db.db.prepare("DELETE FROM semantic_memory WHERE id = ?").run(id);
      db.insertSemanticMemory({ ...memory, content: "different replacement" });
      throw new Error("simulated extraction failure");
    }), /simulated/);
    assert.deepEqual(db.db.prepare("SELECT * FROM semantic_memory WHERE id = ?").get(id), before);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM semantic_memory").get().n, 1);
    assert.equal(calls.length, 1);
    db.insertSemanticMemory({ ...memory, content: "outside transaction" });
    assert.equal(calls.length, 2, "ordinary inserts still verify immediately");
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});
