import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildScriptRuntime } from "../../scripts/run-maintenance.mjs";
import { withFixtureDb } from "../helpers/fixture-db.mjs";

test("maintenance hydrates raw sessions only through approved repository mappings", async () => {
  const fixture = await withFixtureDb();
  const raw = new DatabaseSync(fixture.config.paths.rawStorePath);
  raw.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,repository TEXT,branch TEXT,summary TEXT,created_at TEXT,updated_at TEXT)");
  raw.prepare("INSERT INTO sessions VALUES('mapped',NULL,'owner/repo',NULL,'fixture','2026-01-01','2026-01-01')").run();
  raw.close();
  fixture.db.close();
  const { db, runtime } = buildScriptRuntime({ args: {}, config: fixture.config });
  try {
    const row = { id: "mapped", repository: "owner/repo", cwd: null };
    assert.equal(runtime.sessionStore.hydrateSessionRow(row).repository, null);
    db.setRepositoryMapping({ legacy: "owner/repo", canonical: "github.com/owner/repo" });
    assert.equal(runtime.sessionStore.hydrateSessionRow(row).repository, "github.com/owner/repo");
    assert.equal(runtime.sessionStore.hydrateSessionRow({ ...row, id: "unknown", repository: "other/repo" }).repository, null);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM semantic_memory").get().n, 0);
  } finally { runtime.sessionStore.db?.close(); db.close(); fixture.cleanup(); }
});
