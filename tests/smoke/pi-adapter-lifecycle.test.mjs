import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HARNESS = path.join(REPO_ROOT, "tests", "fixtures", "pi-adapter-harness.mjs");
const LOADER = path.join(REPO_ROOT, "tests", "fixtures", "pi-adapter-loader.mjs");
const STRIP_TYPES_AVAILABLE = process.allowedNodeEnvironmentFlags.has("--experimental-strip-types");

test("pi adapter shares initialization and recovers after its worker exits", {
  skip: !STRIP_TYPES_AVAILABLE,
}, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lore-pi-adapter-test-"));
  const config = path.join(dir, "lore.json");
  const launches = path.join(dir, "launches");
  const onceState = path.join(dir, "once");
  writeFileSync(config, JSON.stringify({ enabled: true }));

  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--experimental-loader",
    LOADER,
    HARNESS,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LORE_CONFIG: config,
      LORE_PI_TRANSPORT_MODE: "exit-once",
      LORE_PI_TRANSPORT_LAUNCHES: launches,
      LORE_PI_TRANSPORT_ONCE_STATE: onceState,
    },
    timeout: 10_000,
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), { ok: true });
    assert.equal(readFileSync(launches, "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pi adapter resolves node from PATH instead of a non-node process.execPath", {
  skip: !STRIP_TYPES_AVAILABLE,
}, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lore-pi-exec-path-test-"));
  const config = path.join(dir, "lore.json");
  // pi is a Bun-compiled binary: process.execPath is pi itself, not node.
  const fakeHost = path.join(dir, "pi-binary");
  writeFileSync(config, JSON.stringify({ enabled: true }));
  writeFileSync(fakeHost, "#!/bin/sh\nexit 1\n");
  chmodSync(fakeHost, 0o755);

  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--experimental-loader",
    LOADER,
    HARNESS,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LORE_CONFIG: config,
      LORE_NODE: "",
      LORE_PI_FAKE_EXEC_PATH: fakeHost,
    },
    timeout: 10_000,
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
