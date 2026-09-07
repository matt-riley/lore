import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { LoreDb } from "../../lib/db/db.mjs";
import { SCHEMA_VERSION } from "../../lib/db/schema.mjs";
import { withFixtureDb } from "../helpers/fixture-db.mjs";

test("read-only facade cannot write data or create backups while inspecting existing data", async () => {
  const { db, config, cleanup } = await withFixtureDb();
  try {
    db.insertSemanticMemory({ type: "user_preference", content: "Prefer kiwi fixtures.", scope: "repo", repository: "fixture/readonly" });
    db.close();
    const bytes = readFileSync(config.paths.derivedStorePath);
    const entries = readdirSync(path.dirname(config.paths.derivedStorePath));
    const readonly = new LoreDb(config);
    try {
      readonly.openReadOnly();
      assert.equal(readonly.searchSemantic({ query: "kiwi", repository: "fixture/readonly" }).length, 1);
      assert.throws(() => readonly.db.prepare("DELETE FROM semantic_memory").run(), /readonly|read-only/i);
    } finally { readonly.close(); }
    assert.deepEqual(readFileSync(config.paths.derivedStorePath), bytes);
    // SQLite may create its WAL coordination files even for a read-only
    // connection. It must not write a transaction or create application files.
    const coordination = new Set([`${path.basename(config.paths.derivedStorePath)}-wal`, `${path.basename(config.paths.derivedStorePath)}-shm`]);
    assert.deepEqual(readdirSync(path.dirname(config.paths.derivedStorePath)).filter((name) => !coordination.has(name)), entries.filter((name) => !coordination.has(name)));
    const wal = `${config.paths.derivedStorePath}-wal`;
    if (existsSync(wal)) assert.equal(readFileSync(wal).length, 0);
  } finally { cleanup(); }
});

test("read-only facade reports missing stores without creating directories", async () => {
  const { db, config, cleanup } = await withFixtureDb();
  try {
    db.close();
    const missing = path.join(path.dirname(config.paths.derivedStorePath), "missing", "lore.db");
    const readonly = new LoreDb({ ...config, paths: { ...config.paths, derivedStorePath: missing } });
    assert.throws(() => readonly.openReadOnly(), (error) => error.code === "DATABASE_UNAVAILABLE");
    assert.equal(existsSync(path.dirname(missing)), false);
  } finally { cleanup(); }
});

test("read-only facade rejects old schemas without upgrading them", async () => {
  const { db, config, cleanup } = await withFixtureDb();
  try {
    db.db.prepare("UPDATE lore_schema_version SET version = ?").run(SCHEMA_VERSION - 1);
    db.close();
    const bytes = readFileSync(config.paths.derivedStorePath);
    const readonly = new LoreDb(config);
    assert.throws(() => readonly.openReadOnly(), (error) => error.code === "SCHEMA_UPGRADE_REQUIRED");
    assert.equal(readonly.db, null);
    assert.deepEqual(readFileSync(config.paths.derivedStorePath), bytes);
  } finally { cleanup(); }
});

test("read-only previews include committed WAL records without checkpointing the writer", async () => {
  const { db, config, cleanup } = await withFixtureDb();
  try {
    db.db.exec("PRAGMA wal_autocheckpoint = 0");
    const id = db.insertSemanticMemory({ type: "user_preference", content: "Prefer citrus fixtures.", scope: "repo", repository: "fixture/readonly" });
    const main = readFileSync(config.paths.derivedStorePath);
    const wal = readFileSync(`${config.paths.derivedStorePath}-wal`);
    const readonly = new LoreDb(config);
    try {
      readonly.openReadOnly();
      assert.equal(readonly.searchSemantic({ query: "citrus", repository: "fixture/readonly" })[0]?.id, id);
    } finally { readonly.close(); }
    assert.deepEqual(readFileSync(config.paths.derivedStorePath), main);
    assert.deepEqual(readFileSync(`${config.paths.derivedStorePath}-wal`), wal);
  } finally { cleanup(); }
});
