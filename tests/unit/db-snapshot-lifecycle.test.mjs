import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { inspectDatabase, validateCanonicalShape } from "../../lib/db/db-snapshot-lifecycle.mjs";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "../../lib/db/schema.mjs";

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-snapshot-test-"));
}

describe("db-snapshot-lifecycle", () => {
  test("validateCanonicalShape handles databases with reserved words and special characters in table names", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const statement of SCHEMA_STATEMENTS) {
        db.exec(statement);
      }

      // Add extra tables and views with reserved words, spaces, hyphens, and quotes
      db.exec(`
        CREATE TABLE "order" (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE "group" (id TEXT PRIMARY KEY, "where" TEXT);
        CREATE TABLE "table with spaces" (id TEXT PRIMARY KEY);
        CREATE TABLE "table-with-dashes" (id TEXT PRIMARY KEY);
        CREATE TABLE "table""with""quotes" (id TEXT PRIMARY KEY, "col""quote" TEXT);
        CREATE VIEW "view with spaces" AS SELECT id FROM "order";
      `);

      // validateCanonicalShape inspects schemaShape for all tables/views via PRAGMA table_info
      // It should safely quote all identifiers without throwing a SQL syntax error
      assert.doesNotThrow(() => {
        validateCanonicalShape(db);
      });
    } finally {
      db.close();
    }
  });

  test("validateCanonicalShape detects missing canonical tables even with unusual table names present", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE "order" (id TEXT PRIMARY KEY);
        CREATE TABLE "special table" (id TEXT PRIMARY KEY);
      `);

      assert.throws(
        () => validateCanonicalShape(db),
        /snapshot is not a complete Lore database/,
      );
    } finally {
      db.close();
    }
  });

  test("inspectDatabase safely handles databases containing reserved words and special character tables", () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "test.db");
    try {
      const db = new DatabaseSync(dbPath);
      try {
        for (const statement of SCHEMA_STATEMENTS) {
          db.exec(statement);
        }
        db.exec(`
          CREATE TABLE "order" (id TEXT PRIMARY KEY, "desc" TEXT);
          CREATE TABLE "table-with-dashes" (id TEXT PRIMARY KEY);
          CREATE TABLE "table with spaces""and quotes" (id TEXT PRIMARY KEY);
          INSERT INTO lore_schema_version (version) VALUES (${SCHEMA_VERSION});
        `);
      } finally {
        db.close();
      }

      const result = inspectDatabase(dbPath);
      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.integrity, "ok");
      assert.strictEqual(result.schemaVersion, SCHEMA_VERSION);
      assert.strictEqual(result.schemaTable, "lore_schema_version");
      assert.strictEqual(result.requiredTables, true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("inspectDatabase reports requiredTables as false when required columns are missing", () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "incomplete.db");
    try {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`
          CREATE TABLE "order" (id TEXT PRIMARY KEY);
          CREATE TABLE lore_schema_version (version INTEGER);
          INSERT INTO lore_schema_version (version) VALUES (${SCHEMA_VERSION});
          CREATE TABLE semantic_memory (id TEXT PRIMARY KEY);
        `);
      } finally {
        db.close();
      }

      const result = inspectDatabase(dbPath);
      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.integrity, "ok");
      assert.strictEqual(result.requiredTables, false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
