/**
 * tests/helpers/temp-home.mjs
 *
 * Creates and tears down isolated temporary Copilot home directories.
 *
 * Each temp home mimics the real ~/.copilot layout so that config loading,
 * DB initialization, and extension hooks all behave as if they were running in
 * an actual install — without touching the developer's real home.
 *
 * Usage:
 *   import { createTempHome } from '../helpers/temp-home.mjs';
 *
 *   // In a test:
 *   const { home, paths, cleanup } = createTempHome();
 *   try {
 *     // ... test code using home / paths ...
 *   } finally {
 *     cleanup();
 *   }
 *
 *   // Or with afterEach / using:
 *   const { home, paths, cleanup } = createTempHome();
 *   after(cleanup);
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Well-known sub-paths inside a Copilot home directory that Lore uses.
 * Returned as `paths` from createTempHome so callers do not have to
 * re-derive them.
 *
 * @param {string} home - Absolute path to the temp home root.
 * @returns {object} Path constants derived from home.
 */
export function buildHomePaths(home) {
  return {
    home,
    configFile: path.join(home, "lore.json"),
    derivedStore: path.join(home, "lore.db"),
    rawStore: path.join(home, "session-store.db"),
    backupDir: path.join(home, "backups", "lore"),
    instructionsFile: path.join(home, "copilot-instructions.md"),
    scopedInstructionsDir: path.join(home, "instructions"),
    extensionsDir: path.join(home, "extensions"),
  };
}

/**
 * Create an isolated, disposable Copilot home directory for tests.
 *
 * The created directory is populated with the standard subdirectory skeleton
 * and an empty copilot-instructions.md so that config loading and DB
 * initialization do not fail on missing paths.
 *
 * An optional `configOverrides` object is merged (shallowly) into the default
 * lore.json written to the home.  Pass `{ enabled: true }` to simulate a
 * user who has opted-in, for example.
 *
 * @param {{ configOverrides?: object }} [options]
 * @returns {{ home: string, paths: object, cleanup: () => void }}
 */
export function createTempHome({ configOverrides = {} } = {}) {
  // Prefix ensures log output clearly identifies lore test dirs.
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-test-"));
  const p = buildHomePaths(home);

  // Skeleton directories that Lore's config, db, and script modules expect.
  for (const dir of [p.backupDir, p.scopedInstructionsDir, p.extensionsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // Minimal lore.json.  Default to enabled:false so tests are opt-in
  // about turning lore on rather than accidentally triggering real writes.
  const configContent = { enabled: false, ...configOverrides };
  writeFileSync(p.configFile, JSON.stringify(configContent, null, 2), "utf8");

  // Empty instructions file avoids readFile errors in path-dependent modules.
  writeFileSync(p.instructionsFile, "", "utf8");

  function cleanup() {
    rmSync(home, { recursive: true, force: true });
  }

  return { home, paths: p, cleanup };
}
