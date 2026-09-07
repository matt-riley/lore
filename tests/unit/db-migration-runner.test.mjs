import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MigrationRunner } from "../../lib/db/db-migration-runner.mjs";

describe("db-migration-runner", () => {
  test("tableHasColumn and ensureColumn safely handle reserved words and special characters in identifiers", () => {
    const db = new DatabaseSync(":memory:");
    const runner = new MigrationRunner(db, {});

    // Reserved SQL keywords as table and column names
    db.exec(`CREATE TABLE "order" (id TEXT PRIMARY KEY);`);
    assert.strictEqual(runner.tableHasColumn("order", "id"), true);
    assert.strictEqual(runner.tableHasColumn("order", "group"), false);

    // ensureColumn with reserved SQL words for table and column
    runner.ensureColumn("order", "group", "TEXT");
    assert.strictEqual(runner.tableHasColumn("order", "group"), true);

    // ensureColumn is idempotent when column already exists
    runner.ensureColumn("order", "group", "TEXT");
    assert.strictEqual(runner.tableHasColumn("order", "group"), true);

    // Identifiers with special characters: spaces, hyphens, and embedded double quotes
    const trickyTable = `special-table name"with"quotes`;
    const trickyColumn = `user-column name"with"quotes`;
    db.exec(`CREATE TABLE "special-table name""with""quotes" (id TEXT PRIMARY KEY);`);

    assert.strictEqual(runner.tableHasColumn(trickyTable, "id"), true);
    assert.strictEqual(runner.tableHasColumn(trickyTable, trickyColumn), false);

    runner.ensureColumn(trickyTable, trickyColumn, "TEXT DEFAULT 'default-val'");
    assert.strictEqual(runner.tableHasColumn(trickyTable, trickyColumn), true);

    // Verify the column was actually added with the proper definition
    db.exec(`INSERT INTO "special-table name""with""quotes" (id) VALUES ('row-1');`);
    const row = db.prepare(`SELECT "user-column name""with""quotes" AS val FROM "special-table name""with""quotes" WHERE id = 'row-1'`).get();
    assert.strictEqual(row.val, "default-val");

    db.close();
  });
});
