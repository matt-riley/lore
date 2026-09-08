import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";

import { LoreDb } from "../../lib/db/db.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-wal-concurrency-"));
}

describe("db WAL concurrency", () => {
  test("two processes can concurrently read and write to the same database in WAL mode", { skip: SKIP_NO_FTS5 }, async () => {
    const root = tempDir();
    const dbPath = path.join(root, "concurrency.db");

    try {
      // Initialize the database with schema
      const parentDb = new LoreDb({ paths: { derivedStorePath: dbPath } });
      parentDb.initialize();

      // Write initial record
      parentDb.insertSemanticMemory({
        id: "mem-init",
        type: "fact",
        content: "Initial database seed memory.",
        repository: "test-repo",
      });

      // Child worker script that performs sequential writes with reads
      const workerScript = `
        import { LoreDb } from "./lib/db/db.mjs";
        const db = new LoreDb({ paths: { derivedStorePath: process.env.DB_PATH } });
        db.initialize();
        for (let i = 0; i < 15; i++) {
          db.insertSemanticMemory({
            id: "child-mem-" + i,
            type: "fact",
            content: "Child process memory item " + i,
            repository: "test-repo",
          });
          const search = db.searchSemantic({ query: "child", repository: "test-repo" });
          if (search.length === 0) {
            process.exit(2);
          }
        }
        db.close();
        process.exit(0);
      `;

      const child = spawn(process.execPath, ["--input-type=module", "-e", workerScript], {
        cwd: process.cwd(),
        env: { ...process.env, DB_PATH: dbPath },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Parent performs writes and reads concurrently
      for (let i = 0; i < 15; i++) {
        parentDb.insertSemanticMemory({
          id: `parent-mem-${i}`,
          type: "fact",
          content: `Parent process memory item ${i}`,
          repository: "test-repo",
        });
        const search = parentDb.searchSemantic({ query: "parent", repository: "test-repo" });
        assert.ok(search.length > 0);
      }

      const childExit = await new Promise((resolve) => {
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("exit", (code) => resolve({ code, stderr }));
      });

      assert.equal(childExit.code, 0, `Child process failed with stderr: ${childExit.stderr}`);

      // Verify all 31 records (1 init + 15 child + 15 parent) exist
      const allParent = parentDb.searchSemantic({ query: "memory", repository: "test-repo", limit: 50 });
      assert.equal(allParent.length, 31);

      parentDb.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
