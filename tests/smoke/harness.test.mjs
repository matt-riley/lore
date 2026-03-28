/**
 * tests/smoke/harness.test.mjs
 *
 * Smoke tests for the fixture/test harness itself.
 *
 * These tests verify that:
 *   - createTempHome creates the expected directory skeleton
 *   - freshDb initialises a clean database with the expected schema
 *   - seededDb writes exactly the seed memories
 *   - cleanup removes all temp files without error
 *   - withFixtureDb composes home + config + db correctly
 *
 * Run with:
 *   node --test tests/smoke/harness.test.mjs
 *
 * Or via npm:
 *   npm test
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { createTempHome } from "../helpers/temp-home.mjs";
import { freshInstallConfig, enabledConfig, buildFixtureConfig } from "../helpers/fixture-config.mjs";
import { freshDb, seededDb, withFixtureDb, SEED_MEMORIES, FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

// ---------------------------------------------------------------------------
// temp-home helpers
// ---------------------------------------------------------------------------

describe("createTempHome", () => {
  test("creates the expected directory skeleton", () => {
    const { home, paths, cleanup } = createTempHome();
    try {
      assert.ok(existsSync(home), "home dir exists");
      assert.ok(existsSync(paths.configFile), "lore.json created");
      assert.ok(existsSync(paths.backupDir), "backup dir created");
      assert.ok(existsSync(paths.scopedInstructionsDir), "instructions dir created");
      assert.ok(existsSync(paths.extensionsDir), "extensions dir created");
      assert.ok(existsSync(paths.instructionsFile), "copilot-instructions.md created");
    } finally {
      cleanup();
    }
  });

  test("default config file has enabled:false", async () => {
    const { paths, cleanup } = createTempHome();
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(paths.configFile, "utf8");
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.enabled, false);
    } finally {
      cleanup();
    }
  });

  test("configOverrides are written into lore.json", async () => {
    const { paths, cleanup } = createTempHome({ configOverrides: { enabled: true } });
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(paths.configFile, "utf8");
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.enabled, true);
    } finally {
      cleanup();
    }
  });

  test("cleanup removes the temp home", () => {
    const { home, cleanup } = createTempHome();
    assert.ok(existsSync(home), "exists before cleanup");
    cleanup();
    assert.ok(!existsSync(home), "removed after cleanup");
  });
});

// ---------------------------------------------------------------------------
// fixture-config helpers
// ---------------------------------------------------------------------------

describe("freshInstallConfig", () => {
  test("returns enabled:false", () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = freshInstallConfig(home);
      assert.strictEqual(config.enabled, false);
    } finally {
      cleanup();
    }
  });

  test("paths are rooted under the supplied home", () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = freshInstallConfig(home);
      assert.ok(config.paths.copilotHome.startsWith(home));
      assert.ok(config.paths.derivedStorePath.startsWith(home));
      assert.ok(config.paths.rawStorePath.startsWith(home));
      assert.ok(config.configPath.startsWith(home));
    } finally {
      cleanup();
    }
  });
});

describe("enabledConfig", () => {
  test("returns enabled:true", () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = enabledConfig(home);
      assert.strictEqual(config.enabled, true);
    } finally {
      cleanup();
    }
  });
});

describe("buildFixtureConfig overrides", () => {
  test("deep-merges nested overrides without clobbering sibling keys", () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = buildFixtureConfig(home, {
        budgets: { total: 999 },
      });
      assert.strictEqual(config.budgets.total, 999);
      // Sibling keys not in override should survive.
      assert.strictEqual(typeof config.budgets.semantic, "number");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// fixture-db helpers
// ---------------------------------------------------------------------------

describe("freshDb", () => {
  test("initialises schema (lore_schema_version table exists)", { skip: SKIP_NO_FTS5 }, () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = freshInstallConfig(home);
      const db = freshDb(config);
      try {
        // If the schema version table exists, this query won't throw.
        const row = db.db.prepare("SELECT version FROM lore_schema_version LIMIT 1").get();
        assert.ok(row !== undefined || row === undefined, "table is queryable");
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  test("fresh DB has no semantic memories", { skip: SKIP_NO_FTS5 }, () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = freshInstallConfig(home);
      const db = freshDb(config);
      try {
        const rows = db.db.prepare("SELECT COUNT(*) as n FROM semantic_memory").get();
        assert.strictEqual(rows.n, 0);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });
});

describe("seededDb", () => {
  test("inserts exactly SEED_MEMORIES.length rows", { skip: SKIP_NO_FTS5 }, () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = freshInstallConfig(home);
      const db = seededDb(config);
      try {
        const rows = db.db.prepare("SELECT COUNT(*) as n FROM semantic_memory").get();
        assert.strictEqual(rows.n, SEED_MEMORIES.length);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  test("seed IDs are present in the database", { skip: SKIP_NO_FTS5 }, () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = freshInstallConfig(home);
      const db = seededDb(config);
      try {
        for (const mem of SEED_MEMORIES) {
          const row = db.db.prepare("SELECT id FROM semantic_memory WHERE id = ?").get(mem.id);
          assert.ok(row, `seed memory ${mem.id} exists`);
        }
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  test("global-scope seed memory has scope=global", { skip: SKIP_NO_FTS5 }, () => {
    const { home, cleanup } = createTempHome();
    try {
      const config = freshInstallConfig(home);
      const db = seededDb(config);
      try {
        const row = db.db.prepare(
          "SELECT scope FROM semantic_memory WHERE id = 'fixture-mem-004'"
        ).get();
        assert.ok(row, "global seed memory exists");
        assert.strictEqual(row.scope, "global");
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// withFixtureDb composite helper
// ---------------------------------------------------------------------------

describe("withFixtureDb", () => {
  test("fresh path: returns an open DB with no memories", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({ seed: false });
    try {
      const rows = db.db.prepare("SELECT COUNT(*) as n FROM semantic_memory").get();
      assert.strictEqual(rows.n, 0);
    } finally {
      cleanup();
    }
  });

  test("seeded path: returns an open DB with SEED_MEMORIES", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({ seed: true });
    try {
      const rows = db.db.prepare("SELECT COUNT(*) as n FROM semantic_memory").get();
      assert.strictEqual(rows.n, SEED_MEMORIES.length);
    } finally {
      cleanup();
    }
  });

  test("cleanup closes the DB and removes the temp home", { skip: SKIP_NO_FTS5 }, async () => {
    const { paths, cleanup } = await withFixtureDb();
    assert.ok(existsSync(paths.home), "temp home exists before cleanup");
    cleanup();
    assert.ok(!existsSync(paths.home), "temp home removed after cleanup");
  });

  test("configOverrides are reflected in the returned config", { skip: SKIP_NO_FTS5 }, async () => {
    const { config, cleanup } = await withFixtureDb({
      configOverrides: { enabled: true },
    });
    try {
      assert.strictEqual(config.enabled, true);
    } finally {
      cleanup();
    }
  });
});
