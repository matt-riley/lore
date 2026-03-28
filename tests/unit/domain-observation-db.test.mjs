import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { LoreDb } from "../../lib/db.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-domain-db-"));
}

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

describe("LoreDb domain and observation helpers", () => {
  test("upserts and lists domains and observations", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const dbPath = path.join(tempHome, "lore.db");
    const backupDir = path.join(tempHome, "backups");

    try {
      const loreDb = new LoreDb({
        paths: {
          derivedStorePath: dbPath,
          backupDir,
        },
      });
      loreDb.initialize();

      const domainKey = loreDb.upsertMemoryDomain({
        domainKey: "repo:core",
        kind: "repo",
        title: "Core Lore",
        mission: "Track repo-level memory",
        repository: "mattriley/lore",
        scope: "repo",
        directives: ["prefer local-first"],
      });

      const observationKey = loreDb.upsertObservation({
        observationKey: "repo:core:summary",
        domainKey,
        title: "Repo summary",
        prompt: "What changed recently?",
        focus: "summary",
        summary: "Wave 1 is active.",
        repository: "mattriley/lore",
        scope: "repo",
        source: "lore_reflect",
      });

      loreDb.insertSemanticMemory({
        type: "decision",
        content: "Wave 1 stores domains and observations.",
        repository: "mattriley/lore",
        scope: "repo",
        domainKey,
        metadata: { source: "test" },
      });

      assert.equal(loreDb.getMemoryDomain(domainKey)?.title, "Core Lore");
      assert.equal(loreDb.getObservation(observationKey)?.domainKey, domainKey);
      assert.equal(loreDb.listMemoryDomains({ repository: "mattriley/lore" }).length, 1);
      assert.equal(loreDb.listObservations({ repository: "mattriley/lore", domainKey }).length, 1);
      assert.equal(
        loreDb.searchSemantic({ query: "domains observations", repository: "mattriley/lore" })[0]?.domainKey,
        domainKey,
      );

      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
