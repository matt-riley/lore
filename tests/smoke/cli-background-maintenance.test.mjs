/**
 * tests/smoke/cli-background-maintenance.test.mjs
 *
 * End-to-end coverage for the native CLI hook -> detached background
 * maintenance path (lib/clients/cli-runtime.mjs's maybeSpawnBackgroundMaintenance
 * -> scripts/run-maintenance.mjs --background -> runBackgroundMaintenanceSweep).
 *
 * Unit tests elsewhere inject a fake spawner and stub the DB lock directly;
 * this is the one smoke test that lets a real detached child run against an
 * isolated LORE_HOME, so the wiring between the hook process, the spawned
 * script, and the maintenance_run bookkeeping is verified for real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const entry = fileURLToPath(new URL("../../lore-cli.mjs", import.meta.url));

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for background maintenance to complete");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function readLatestMaintenanceRun(dbPath) {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT trigger, status, dry_run FROM maintenance_run ORDER BY updated_at DESC LIMIT 1").get() ?? null;
  } catch {
    // The table may not exist yet the instant the DB file first appears.
    return null;
  } finally {
    db.close();
  }
}

test("a native CLI SessionStart hook spawns a real detached background sweep that completes on its own", { skip: !FTS5_AVAILABLE }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-cli-bg-maintenance-"));
  const configPath = path.join(home, "lore.json");
  const dbPath = path.join(home, "lore.db");
  const env = { ...process.env, HOME: home, LORE_HOME: home, LORE_CONFIG: configPath, LORE_ENABLED: "true" };
  writeFileSync(configPath, JSON.stringify({
    enabled: true,
    maintenanceScheduler: {
      enabled: true,
      autoRunOnSessionStart: true,
    },
    deferredExtraction: {
      enabled: true,
      autoProcessOnSessionStart: true,
    },
  }));
  try {
    const result = spawnSync(process.execPath, [entry, "hook", "claude", "SessionStart"], {
      env,
      input: JSON.stringify({ session_id: "bg-sweep", cwd: home }),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /\[lore\]/, result.stderr);
    // The hook protocol's stdout must stay exactly one JSON line even though a
    // background sweep was spawned alongside it.
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(JSON.parse(lines[0]));

    // Wait for the run to reach a terminal status, not merely for the row to
    // exist: createMaintenanceRun() inserts it with status "running" before
    // the sweep's tasks execute, so a predicate that resolves on existence
    // alone can catch that transient state under load and fail the
    // status assertion below with no more polling left to recover.
    const run = await waitFor(() => {
      const latest = readLatestMaintenanceRun(dbPath);
      return latest && latest.status !== "running" ? latest : null;
    });
    assert.equal(run.trigger, "session_start");
    assert.equal(run.dry_run, 0);
    assert.notEqual(run.status, "running");

    await waitFor(() => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const held = db.prepare("SELECT * FROM maintenance_lock WHERE scope = 'background' AND expires_at > ?").get(new Date().toISOString());
        return held === undefined;
      } finally {
        db.close();
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
