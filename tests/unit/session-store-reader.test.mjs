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
