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
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function runFrom(repoRoot, scriptFile, args = [], { env = {} } = {}) {
  return spawnSync("node", [path.join(repoRoot, "scripts", scriptFile), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
}

function copyDir(sourcePath, targetPath) {
  cpSync(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: (currentPath) => {
      const baseName = path.basename(currentPath);
      return baseName !== ".git" && baseName !== "node_modules" && baseName !== ".DS_Store";
    },
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

describe("dev-install", () => {
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
      assert.ok(
        result.stdout.includes("directory install"),
        `Expected directory install guidance in stdout.\nActual: ${result.stdout}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("reports that an existing symlink will be replaced with a real directory install", () => {
    const tempHome = makeTempDir();
    const extensionsDir = path.join(tempHome, "extensions");
    const linkTarget = path.join(extensionsDir, "lore");
    try {
      mkdirSync(extensionsDir, { recursive: true });
      symlinkSync(REPO_ROOT, linkTarget, "dir");

      const result = run("dev-install.mjs", ["--dry-run", "--copilot-home", tempHome]);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes("Replacing existing symlink"),
        `Expected replacement notice in stdout.\nActual: ${result.stdout}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("refreshes an existing Lore install directory on dry-run", () => {
    const tempHome = makeTempDir();
    const extensionsDir = path.join(tempHome, "extensions");
    const installTarget = path.join(extensionsDir, "lore");
    try {
      mkdirSync(installTarget, { recursive: true });

      const result = run("dev-install.mjs", ["--dry-run", "--copilot-home", tempHome]);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes("Refreshing existing Lore install directory"),
        `Expected refresh notice in stdout.\nActual: ${result.stdout}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("exits 1 and prints ERROR when target exists as a non-directory file", () => {
    const tempHome = makeTempDir();
    const extensionsDir = path.join(tempHome, "extensions");
    const linkTarget = path.join(extensionsDir, "lore");
    try {
      mkdirSync(extensionsDir, { recursive: true });
      // Create a real file where the Lore directory would go — should be rejected.
      writeFileSync(linkTarget, "not a directory");

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

  test("installs Lore as a real directory copy", () => {
    const tempHome = makeTempDir();
    const installTarget = path.join(tempHome, "extensions", "lore");
    try {
      const result = run("dev-install.mjs", ["--copilot-home", tempHome]);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(existsSync(path.join(installTarget, "extension.mjs")), "expected installed extension.mjs");
      assert.ok(existsSync(path.join(installTarget, "lib", "config.mjs")), "expected installed lib/config.mjs");
      assert.equal(lstatSync(installTarget).isSymbolicLink(), false, "expected a real directory install");
      const installedExtension = readFileSync(path.join(installTarget, "extension.mjs"), "utf8");
      assert.ok(
        installedExtension.includes("joinSession"),
        "expected the copied extension entrypoint to contain joinSession",
      );
      assert.ok(
        result.stdout.includes("Restart the Copilot CLI process"),
        `Expected restart guidance in stdout.\nActual: ${result.stdout}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("no-ops when run from the live install directory", () => {
    const tempHome = makeTempDir();
    const installTarget = path.join(tempHome, "extensions", "lore");
    try {
      mkdirSync(path.join(tempHome, "extensions"), { recursive: true });
      copyDir(REPO_ROOT, installTarget);

      const result = runFrom(installTarget, "dev-install.mjs", ["--copilot-home", tempHome]);
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes("already running from the install directory"),
        `Expected already-installed guidance in stdout.\nActual: ${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes("git pull"),
        `Expected git pull guidance in stdout.\nActual: ${result.stdout}`,
      );
      assert.ok(existsSync(path.join(installTarget, "extension.mjs")), "expected extension.mjs to remain in place");
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
