import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { SessionStoreReader } from "../../lib/session-store-reader.mjs";
import { buildFixtureConfig } from "../helpers/fixture-config.mjs";

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-session-store-"));
}

describe("SessionStoreReader.initialize", () => {
  test("throws a clear error when session-store.db is missing", () => {
    const tempHome = makeTempDir();
    try {
      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      assert.throws(
        () => reader.initialize(),
        /session-store\.db not found .*Lore requires the Copilot CLI session store/i,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("opens a readonly raw store when the file exists", () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
      const db = new DatabaseSync(rawStorePath);
      db.close();

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      assert.ok(reader.db, "expected session-store reader to hold an open database");
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("SessionStoreReader.getRecentSessionsWindow", () => {
  test("returns hydrated rows with limit and offset applied", () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
      const db = new DatabaseSync(rawStorePath);
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT,
          repository TEXT,
          branch TEXT,
          summary TEXT,
          created_at TEXT,
          updated_at TEXT
        );
      `);
      db.prepare(`
        INSERT INTO sessions (id, repository, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run("session-1", "repo-one", "first", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z");
      db.prepare(`
        INSERT INTO sessions (id, repository, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run("session-2", "repo-two", "second", "2026-03-30T10:01:00Z", "2026-03-30T10:01:00Z");
      db.close();

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const rows = reader.getRecentSessionsWindow({ limit: 1, offset: 1 });

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, "session-1");
      assert.strictEqual(rows[0].repository, "repo-one");
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
