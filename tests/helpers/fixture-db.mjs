/**
 * tests/helpers/fixture-db.mjs
 *
 * Opens LoreDb instances pointed at fixture homes and optionally seeds
 * them with deterministic test data.
 *
 * Two primary fixture paths are provided:
 *
 *   freshDb(config)  — initialises schema on a brand-new database.
 *                      Represents a user who has enabled Lore for the first
 *                      time.  No memories, no history.
 *
 *   seededDb(config) — calls freshDb then inserts a small, deterministic set
 *                      of memories so tests can assert against known state
 *                      without needing to build up data themselves.
 *
 * Every helper returns the open LoreDb instance.  Callers are responsible
 * for calling db.close() when done (usually in a finally/after block).
 *
 * Usage:
 *   import { freshDb, seededDb, SEED_MEMORIES } from '../helpers/fixture-db.mjs';
 *   import { createTempHome } from '../helpers/temp-home.mjs';
 *   import { freshInstallConfig } from '../helpers/fixture-config.mjs';
 *
 *   const { home, cleanup } = createTempHome();
 *   try {
 *     const config = freshInstallConfig(home);
 *     const db = freshDb(config);
 *     // ... test code ...
 *     db.close();
 *   } finally {
 *     cleanup();
 *   }
 */

import { DatabaseSync } from "node:sqlite";
import { LoreDb } from "../../lib/db.mjs";

// ---------------------------------------------------------------------------
// Runtime capability detection
// ---------------------------------------------------------------------------

/**
 * Whether FTS5 virtual tables are available in the current Node.js SQLite
 * build.  Node.js ships with a bundled SQLite whose compile flags vary by
 * build.  The Copilot CLI runtime typically has FTS5; a developer's system
 * Node (e.g. installed via mise/nvm) may not.
 *
 * Any test that relies on LoreDb.initialize() (which creates FTS5
 * virtual tables) must check this flag and skip when false:
 *
 *   test('...', { skip: !FTS5_AVAILABLE && 'FTS5 not in this Node build' }, () => { ... })
 */
export const FTS5_AVAILABLE = (() => {
  try {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE _fts5_probe USING fts5(content)");
    db.close();
    return true;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Deterministic seed data
// ---------------------------------------------------------------------------

/**
 * A fixed set of memories written by seededDb().
 *
 * All entries use hardcoded IDs so tests can refer to them by ID without
 * querying first.  The repository field is "fixture-repo" so tests can scope
 * queries to known data without risk of cross-contamination with other rows.
 */
export const SEED_MEMORIES = Object.freeze([
  {
    id: "fixture-mem-001",
    type: "preference",
    content: "Use TypeScript strict mode for all new files.",
    repository: "fixture-repo",
    scope: "repo",
    confidence: 1.0,
    tags: ["typescript", "preferences"],
  },
  {
    id: "fixture-mem-002",
    type: "preference",
    content: "Prefer functional components over class components in React.",
    repository: "fixture-repo",
    scope: "repo",
    confidence: 0.9,
    tags: ["react", "preferences"],
  },
  {
    id: "fixture-mem-003",
    type: "fact",
    content: "The primary database is PostgreSQL running on port 5432.",
    repository: "fixture-repo",
    scope: "repo",
    confidence: 1.0,
    tags: ["database", "infrastructure"],
  },
  {
    id: "fixture-mem-004",
    type: "preference",
    content: "Always write unit tests before submitting a pull request.",
    repository: null,
    scope: "global",
    confidence: 1.0,
    tags: ["testing", "workflow"],
  },
]);

// ---------------------------------------------------------------------------
// DB fixture factories
// ---------------------------------------------------------------------------

/**
 * Open a fresh LoreDb from `config` and run schema migrations.
 * The database will be empty (no seed data).
 *
 * @param {object} config - A fixture config from fixture-config.mjs.
 * @returns {LoreDb} An open, initialised database instance.
 */
export function freshDb(config) {
  const db = new LoreDb(config);
  db.initialize();
  return db;
}

/**
 * Open a seeded LoreDb from `config`.
 * Runs schema migrations then inserts SEED_MEMORIES.
 *
 * After this call the database contains exactly the rows in SEED_MEMORIES.
 * Tests that need a known starting state should use this instead of freshDb.
 *
 * @param {object} config - A fixture config from fixture-config.mjs.
 * @returns {LoreDb} An open, seeded database instance.
 */
export function seededDb(config) {
  const db = freshDb(config);
  for (const memory of SEED_MEMORIES) {
    db.insertSemanticMemory(memory);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Convenience: temp home + config + db in one step
// ---------------------------------------------------------------------------

/**
 * Create an isolated temp home, build a config for it, and open a fresh or
 * seeded database — all in one call.
 *
 * Returns the db, config, paths, and a cleanup function that closes the DB
 * and removes the temp home.
 *
 * This is the most ergonomic entry point for tests that only need a working
 * database and do not care about fine-grained fixture control.
 *
 * @param {object} [options]
 * @param {boolean} [options.seed=false] - Whether to seed the DB.
 * @param {object} [options.configOverrides={}] - Passed to buildFixtureConfig.
 * @param {object} [options.homeOptions={}] - Passed to createTempHome.
 * @returns {{ db: LoreDb, config: object, paths: object, cleanup: () => void }}
 */
export async function withFixtureDb({ seed = false, configOverrides = {}, homeOptions = {} } = {}) {
  // Lazy imports to avoid circular dependency issues in callers.
  const { createTempHome } = await import("./temp-home.mjs");
  const { buildFixtureConfig } = await import("./fixture-config.mjs");

  const { home, paths, cleanup: cleanupHome } = createTempHome(homeOptions);
  const config = buildFixtureConfig(home, configOverrides);
  const db = seed ? seededDb(config) : freshDb(config);

  function cleanup() {
    try { db.close(); } catch { /* best-effort */ }
    cleanupHome();
  }

  return { db, config, paths, cleanup };
}
