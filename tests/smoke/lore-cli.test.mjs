import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const cliPath = fileURLToPath(new URL("../../lore-cli.mjs", import.meta.url));

function isolatedEnv(home) {
  const env = { ...process.env, HOME: home, LORE_HOME: home, LORE_CONFIG: path.join(home, "lore.json"), LORE_ENABLED: "true" };
  writeFileSync(env.LORE_CONFIG, JSON.stringify({ enabled: true }));
  return env;
}

test("lore status with stdin closed prints text and exits 0", { skip: !FTS5_AVAILABLE }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-cli-status-"));
  try {
    const result = spawnSync(process.execPath, [cliPath, "status"], {
      cwd: home,
      env: isolatedEnv(home),
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /enabled: true/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("lore forget id uses the shared slash parser without reading stdin", { skip: !FTS5_AVAILABLE }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-cli-forget-"));
  try {
    const env = isolatedEnv(home);
    const retain = spawnSync(process.execPath, [cliPath, "retain", "--type", "user_preference", "prefer focused lore tests"], {
      cwd: home,
      env,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(retain.status, 0, retain.stderr);
    const id = retain.stdout.match(/semantic memory ([^\s.]+)/)?.[1];
    assert.ok(id);
    const forgotten = spawnSync(process.execPath, [cliPath, "forget", id], {
      cwd: home,
      env,
      input: "this must not be parsed as JSON",
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(forgotten.status, 0, forgotten.stderr);
    assert.doesNotMatch(forgotten.stderr, /Expected a JSON object/);
    assert.match(forgotten.stdout, /Forgot|forgotten|suppressed|memory/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("lore doctor remains available as an extra human verb", { skip: !FTS5_AVAILABLE }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-cli-doctor-"));
  try {
    const result = spawnSync(process.execPath, [cliPath, "doctor"], {
      cwd: home,
      env: isolatedEnv(home),
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
