/**
 * tests/smoke/scripts.test.mjs
 *
 * Integration smoke tests for Lore's script entrypoints.
 *
 * Each script is invoked via spawnSync so that the ESM module-level env var
 * binding in lib/config.mjs (resolved at import time) does not leak between
 * tests, and so that subprocess behaviour is exercised exactly as it would be
 * from a real terminal.
 *
 * Tests that require FTS5 (validate-schema and maintenance --dry-run/--status)
 * are guarded with the same SKIP_NO_FTS5 sentinel used elsewhere in the suite.
 *
 * Run with:
 *   node --test tests/smoke/scripts.test.mjs
 *
 * Or via npm:
 *   npm run test:smoke
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a script file from SCRIPTS_DIR via `node`, returning the spawnSync result.
 * cwd defaults to REPO_ROOT so relative imports in scripts resolve correctly.
 */
function run(scriptFile, args = [], { env = {} } = {}) {
  return spawnSync("node", [path.join(SCRIPTS_DIR, scriptFile), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
}

/** Create an isolated temp dir for a single test. */
function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-smoke-"));
}

/**
 * Write an empty-but-valid SQLite database file at `filePath`.
 * SessionStoreReader opens the raw store readonly; it just needs the file to
 * exist as a valid SQLite database so the open does not throw.
 */
function makeEmptySqlite(filePath) {
  const db = new DatabaseSync(filePath);
  db.close();
}

// ---------------------------------------------------------------------------
// validate-config-schema.mjs
// ---------------------------------------------------------------------------

describe("validate-config-schema", () => {
  test("exits 0 and reports schema/config parity", () => {
    const result = run("validate-config-schema.mjs");
    assert.strictEqual(
      result.status,
      0,
      `Expected exit 0.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes("parity"),
      `Expected 'parity' in stdout.\nActual: ${result.stdout}`,
    );
  });
});

// ---------------------------------------------------------------------------
// dev-install.mjs
// ---------------------------------------------------------------------------

describe("dev-install --dry-run", () => {
  test("exits 0 and reports no changes for a fresh temp home", () => {
    const tempHome = makeTempDir();
    try {
      const result = run("dev-install.mjs", ["--dry-run", "--copilot-home", tempHome]);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes("[dry-run]"),
        `Expected '[dry-run]' in stdout.\nActual: ${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes("No changes made"),
        `Expected 'No changes made' in stdout.\nActual: ${result.stdout}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("reports 'Nothing to do' when symlink already points to repo root", () => {
    const tempHome = makeTempDir();
    const extensionsDir = path.join(tempHome, "extensions");
    const linkTarget = path.join(extensionsDir, "lore");
    try {
      mkdirSync(extensionsDir, { recursive: true });
      symlinkSync(REPO_ROOT, linkTarget, "dir");

      const result = run("dev-install.mjs", ["--dry-run", "--copilot-home", tempHome]);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes("Nothing to do"),
        `Expected 'Nothing to do' in stdout.\nActual: ${result.stdout}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("exits 1 and prints ERROR when target exists as a non-symlink directory", () => {
    const tempHome = makeTempDir();
    const extensionsDir = path.join(tempHome, "extensions");
    const linkTarget = path.join(extensionsDir, "lore");
    try {
      // Create a real directory where the symlink would go — should be rejected.
      mkdirSync(linkTarget, { recursive: true });

      const result = run("dev-install.mjs", ["--dry-run", "--copilot-home", tempHome]);
      assert.strictEqual(
        result.status,
        1,
        `Expected exit 1.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.ok(
        result.stderr.includes("ERROR"),
        `Expected 'ERROR' in stderr.\nActual: ${result.stderr}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// run-maintenance.mjs — flag-only paths (no DB, no FTS5 required)
// ---------------------------------------------------------------------------

describe("run-maintenance --help", () => {
  test("exits 0 and prints usage text", () => {
    const result = run("run-maintenance.mjs", ["--help"]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes("Options:"),
      `Expected 'Options:' in stdout.\nActual: ${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes("--dry-run"),
      `Expected '--dry-run' in stdout.\nActual: ${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes("LORE_COPILOT_HOME"),
      `Expected env var docs in stdout.\nActual: ${result.stdout}`,
    );
  });
});

describe("run-maintenance --recommended-schedule", () => {
  test("exits 0 and prints cron schedule guidance", () => {
    const tempHome = makeTempDir();
    try {
      const result = run("run-maintenance.mjs", ["--recommended-schedule"], {
        env: { LORE_COPILOT_HOME: tempHome },
      });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes("cron"),
        `Expected 'cron' in stdout.\nActual: ${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes("validationCorpus"),
        `Expected task names in stdout.\nActual: ${result.stdout}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// run-maintenance.mjs — DB-backed paths (FTS5 required)
// ---------------------------------------------------------------------------

describe("run-maintenance --dry-run", () => {
  test("exits 0 and reports dryRun:true", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    makeEmptySqlite(rawStorePath);
    try {
      const result = run(
        "run-maintenance.mjs",
        ["--dry-run", "--raw-store-path", rawStorePath],
        { env: { LORE_COPILOT_HOME: tempHome } },
      );
      assert.strictEqual(
        result.status,
        0,
        `Expected exit 0.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.ok(
        result.stdout.includes("dryRun: true"),
        `Expected 'dryRun: true' in stdout.\nActual: ${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes("trigger: script"),
        `Expected 'trigger: script' in stdout.\nActual: ${result.stdout}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("run-maintenance --status", () => {
  test("exits 0 and reports trigger:status", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    makeEmptySqlite(rawStorePath);
    try {
      const result = run(
        "run-maintenance.mjs",
        ["--status", "--raw-store-path", rawStorePath],
        { env: { LORE_COPILOT_HOME: tempHome } },
      );
      assert.strictEqual(
        result.status,
        0,
        `Expected exit 0.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.ok(
        result.stdout.includes("trigger: status"),
        `Expected 'trigger: status' in stdout.\nActual: ${result.stdout}`,
      );
      // --status implies dry-run
      assert.ok(
        result.stdout.includes("dryRun: true"),
        `Expected 'dryRun: true' in stdout.\nActual: ${result.stdout}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
