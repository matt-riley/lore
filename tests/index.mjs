/**
 * tests/index.mjs
 *
 * Convenience barrel that re-exports all test harness helpers.
 *
 * Import from here when you need multiple harness pieces in one line:
 *
 *   import { createTempHome, freshDb, seededDb, SEED_MEMORIES } from '../index.mjs';
 *
 * Or import directly from the individual helper files for tree-shaking or
 * when only one piece is needed.
 */

export { createTempHome, buildHomePaths } from "./helpers/temp-home.mjs";
export {
  buildFixtureConfig,
  freshInstallConfig,
  enabledConfig,
} from "./helpers/fixture-config.mjs";
export {
  freshDb,
  seededDb,
  withFixtureDb,
  SEED_MEMORIES,
  FTS5_AVAILABLE,
} from "./helpers/fixture-db.mjs";
