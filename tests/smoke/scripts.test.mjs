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
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";
import { resolveSweepExitCode, parseArgs as parseMaintenanceArgs } from "../../scripts/run-maintenance.mjs";
import { parseArgs as parseBrowserArgs } from "../../scripts/run-browser.mjs";

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

/**
 * Initialize a Lore store through the public write path in a child process.
 * Preview commands must never do this themselves, so tests seed storage first
 * and then assert the preview left it untouched.
 */
function initLoreStore(env) {
  const source = `
    const { LoreDb } = await import(${JSON.stringify(new URL("../../lib/db/db.mjs", import.meta.url).href)});
    const { loadConfig } = await import(${JSON.stringify(new URL("../../lib/core/config.mjs", import.meta.url).href)});
    const db = new LoreDb(await loadConfig());
    db.initialize();
    db.close();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, `initLoreStore failed: ${result.stderr}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForOutput(child, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(buffer);
    };
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${pattern}\n${buffer}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (pattern.test(buffer)) finish();
    });
    child.once("exit", (code) => finish(new Error(`process exited early (${code})\n${buffer}`)));
  });
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
    assert.ok(existsSync(path.join(installTarget, "lib", "core", "config.mjs")), "expected installed lib/core/config.mjs");
    assert.ok(existsSync(path.join(installTarget, "lore-server-runtime.mjs")), "expected copied server runtime");
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
        env: { LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" },
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

  test("includes launchd plist example", () => {
    const tempHome = makeTempDir();
    try {
      const result = run("run-maintenance.mjs", ["--recommended-schedule"], {
        env: { LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" },
      });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes("launchd"),
        `Expected 'launchd' in stdout.\nActual: ${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes("com.lore.maintenance"),
        `Expected launchd label in stdout.\nActual: ${result.stdout}`,
      );
      assert.ok(
        result.stdout.includes("StartInterval"),
        `Expected StartInterval in stdout.\nActual: ${result.stdout}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("includes hook cadence disclaimer", () => {
    const tempHome = makeTempDir();
    try {
      const result = run("run-maintenance.mjs", ["--recommended-schedule"], {
        env: { LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" },
      });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.includes("do NOT guarantee wall-clock cadence"),
        `Expected cadence disclaimer in stdout.\nActual: ${result.stdout}`,
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
  test("exits 0, reports dryRun:true, and leaves store bytes unchanged", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    makeEmptySqlite(rawStorePath);
    const env = { ...process.env, LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" };
    try {
      initLoreStore(env);
      const dbPath = path.join(tempHome, "lore.db");
      const before = readFileSync(dbPath);
      const result = run(
        "run-maintenance.mjs",
        ["--dry-run", "--raw-store-path", rawStorePath],
        { env },
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
      assert.deepEqual(readFileSync(dbPath), before, "dry-run must not mutate the store");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("fails closed without creating a store when storage is absent", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    makeEmptySqlite(rawStorePath);
    try {
      const result = run(
        "run-maintenance.mjs",
        ["--dry-run", "--raw-store-path", rawStorePath],
        { env: { ...process.env, LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" } },
      );
      assert.notEqual(result.status, 0, "previews must not create a missing store");
      assert.match(result.stderr, /unavailable/i);
      assert.match(result.stderr, /lore status/);
      assert.equal(existsSync(path.join(tempHome, "lore.db")), false);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("run-maintenance --status", () => {
  test("exits 0, reports trigger:status, and leaves store bytes unchanged", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    makeEmptySqlite(rawStorePath);
    const env = { ...process.env, LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" };
    try {
      initLoreStore(env);
      const dbPath = path.join(tempHome, "lore.db");
      const before = readFileSync(dbPath);
      const result = run(
        "run-maintenance.mjs",
        ["--status", "--raw-store-path", rawStorePath],
        { env },
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
      assert.deepEqual(readFileSync(dbPath), before, "status must not mutate the store");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// run-browser.mjs — read-only open
// ---------------------------------------------------------------------------

describe("run-browser read-only open", () => {
  test("fails closed without creating a store when storage is absent", async () => {
    const tempHome = makeTempDir();
    try {
      const port = await getFreePort();
      const result = run(
        "run-browser.mjs",
        ["--port", String(port)],
        { env: { ...process.env, LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" } },
      );
      assert.notEqual(result.status, 0, "browser preview must not create a missing store");
      assert.match(result.stderr, /unavailable/i);
      assert.match(result.stderr, /lore status/);
      assert.equal(existsSync(path.join(tempHome, "lore.db")), false);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("rejects a legacy store without migrating it", async () => {
    const tempHome = makeTempDir();
    try {
      const dbPath = path.join(tempHome, "lore.db");
      const legacy = new DatabaseSync(dbPath);
      legacy.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO schema_version VALUES(18,'2026-01-01');");
      legacy.close();
      const before = readFileSync(dbPath);
      const port = await getFreePort();
      const result = run(
        "run-browser.mjs",
        ["--port", String(port)],
        { env: { ...process.env, LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" } },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /schema upgrade required/i);
      assert.match(result.stderr, /lore status/);
      assert.deepEqual(readFileSync(dbPath), before);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("serves an existing store without mutating it", { skip: SKIP_NO_FTS5 }, async () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    makeEmptySqlite(rawStorePath);
    const env = { ...process.env, LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" };
    let child = null;
    try {
      initLoreStore(env);
      const dbPath = path.join(tempHome, "lore.db");
      const before = readFileSync(dbPath);
      const port = await getFreePort();
      child = spawn(process.execPath, [path.join(SCRIPTS_DIR, "run-browser.mjs"), "--port", String(port)], {
        cwd: REPO_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForOutput(child, /local read-only server started/);
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      child = null;
      assert.deepEqual(readFileSync(dbPath), before, "browser preview must not mutate the store");
    } finally {
      if (child) child.kill("SIGKILL");
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// run-maintenance.mjs — exit-code mapping
// ---------------------------------------------------------------------------

describe("run-maintenance exit mapping", () => {
  test("failed sweeps exit nonzero while clean, attention, and skipped runs exit zero", () => {
    assert.equal(resolveSweepExitCode({ status: "completed", failedCount: 0 }), 0);
    assert.equal(resolveSweepExitCode({ status: "needs_attention", failedCount: 0, needsAttentionCount: 2 }), 0);
    assert.equal(resolveSweepExitCode({ status: "skipped", failedCount: 0 }), 0);
    assert.equal(resolveSweepExitCode({ status: "failed", failedCount: 1 }), 1);
    assert.equal(resolveSweepExitCode({ status: "failed", failedCount: 0 }), 1);
  });
});

// ---------------------------------------------------------------------------
// shared-args.mjs — strict parsing
// ---------------------------------------------------------------------------

describe("strict shared argument parsing", () => {
  test("rejects unknown flags, missing values, and option-like values", () => {
    assert.throws(() => parseMaintenanceArgs(["--dryrun", "--repositroy", "fixture"]), /Unknown option '--dryrun'/);
    assert.throws(() => parseMaintenanceArgs(["--tasks"]), /argument missing/);
    assert.throws(() => parseMaintenanceArgs(["--repository", "--dry-run"]), /ambiguous/);
    assert.throws(() => parseMaintenanceArgs(["--derived-store-path"]), /argument missing/);
    assert.throws(() => parseMaintenanceArgs(["stray"]), /Unexpected argument/);
    assert.throws(() => parseBrowserArgs(["--prot", "43111"]), /Unknown option '--prot'/);
  });

  test("still accepts valid flags, booleans, and short help", () => {
    assert.deepEqual(parseMaintenanceArgs(["--dry-run", "--tasks", "validationCorpus,backlogReview"]), {
      action: "run", dryRun: true, force: false, tasks: ["validationCorpus", "backlogReview"],
    });
    assert.equal(parseMaintenanceArgs(["-h"]).action, "help");
    assert.deepEqual(parseBrowserArgs(["--port", "43111", "--host", "localhost"]), {
      host: "localhost", port: 43111, repository: null,
    });
  });

  test("mis-spelled flags fail before storage is opened", () => {
    const tempHome = makeTempDir();
    const env = { ...process.env, LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" };
    try {
      const maintenance = run("run-maintenance.mjs", ["--dryrun", "--repositroy", "fixture"], { env });
      assert.notEqual(maintenance.status, 0);
      assert.match(maintenance.stderr, /Unknown option '--dryrun'/);
      assert.equal(existsSync(path.join(tempHome, "lore.db")), false);

      const missingValue = run("run-maintenance.mjs", ["--tasks"], { env });
      assert.notEqual(missingValue.status, 0);
      assert.match(missingValue.stderr, /argument missing/);
      assert.equal(existsSync(path.join(tempHome, "lore.db")), false);

      const browser = run("run-browser.mjs", ["--prot", "43111"], { env });
      assert.notEqual(browser.status, 0);
      assert.match(browser.stderr, /Unknown option '--prot'/);
      assert.equal(existsSync(path.join(tempHome, "lore.db")), false);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// run-maintenance.mjs — task name validation
// ---------------------------------------------------------------------------

describe("run-maintenance --tasks validation", () => {
  test("exits 1 and prints error when all task names are unknown", () => {
    const result = run("run-maintenance.mjs", ["--tasks", "notATask,alsoNotATask"]);
    assert.strictEqual(
      result.status,
      1,
      `Expected exit 1.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("Unknown task names:"),
      `Expected unknown-task error in stderr.\nActual: ${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("Valid tasks:"),
      `Expected valid-task list in stderr.\nActual: ${result.stderr}`,
    );
  });

  test("exits 1 and lists all known valid tasks in the error message", () => {
    const result = run("run-maintenance.mjs", ["--tasks", "typo"]);
    assert.strictEqual(result.status, 1, `stderr: ${result.stderr}`);
    // Every valid task name should appear in the error guidance
    for (const task of ["validationCorpus", "replayCorpus", "backlogReview", "traceCompaction", "indexUpkeep", "doctorSnapshot"]) {
      assert.ok(
        result.stderr.includes(task),
        `Expected '${task}' in stderr valid-task list.\nActual: ${result.stderr}`,
      );
    }
  });

  test("exits 1 and prints error when task list mixes unknown and valid names", () => {
    // Fail-closed: any unknown name — even alongside valid names — must exit 1 without running tasks.
    const tempHome = makeTempDir();
    try {
      const result = run(
        "run-maintenance.mjs",
        ["--tasks", "validationCorpus,typo", "--dry-run"],
        { env: { LORE_COPILOT_HOME: tempHome, LORE_HOME: tempHome, LORE_CONFIG: "" } },
      );
      assert.strictEqual(
        result.status,
        1,
        `Expected exit 1 for mixed valid+unknown task list.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.ok(
        result.stderr.includes("Unknown task names:"),
        `Expected error in stderr listing unknown tasks.\nActual: ${result.stderr}`,
      );
      assert.ok(
        result.stderr.includes("typo"),
        `Expected 'typo' named in the error.\nActual: ${result.stderr}`,
      );
      assert.ok(
        result.stderr.includes("Valid tasks:"),
        `Expected valid-task list in error guidance.\nActual: ${result.stderr}`,
      );
      // No maintenance DB should be created — the script must exit before opening the DB.
      assert.ok(
        !existsSync(path.join(tempHome, "lore.db")),
        `Expected no lore.db created when exiting early on invalid tasks.\nfound: ${path.join(tempHome, "lore.db")}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
