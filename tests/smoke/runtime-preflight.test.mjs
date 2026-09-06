import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOADER = path.join(ROOT, "tests/fixtures/block-sqlite-loader.mjs");
const CLI = path.join(ROOT, "lore-cli.mjs");
const SERVER = path.join(ROOT, "lore-server.mjs");

test("native hook keeps neutral JSON stdout when node:sqlite cannot load", () => {
  const result = spawnSync(process.execPath, ["--experimental-loader", LOADER, CLI, "hook", "codex", "SessionStart"], {
    input: JSON.stringify({ session_id: "runtime-test", cwd: ROOT }),
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.match(result.stderr, /node:sqlite is unavailable/);
});

test("Pi server preserves JSON-lines errors when node:sqlite cannot load", () => {
  const result = spawnSync(process.execPath, ["--experimental-loader", LOADER, SERVER], {
    input: `${JSON.stringify({ id: "runtime-test", method: "status", params: {} })}\n`,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.deepEqual(response, {
    id: "runtime-test",
    ok: false,
    error: "node:sqlite is unavailable in this Node.js runtime. Install Node.js 24.0.0 or newer with the built-in SQLite module, then rerun Lore.",
  });
  assert.match(result.stderr, /runtime unavailable: node:sqlite is unavailable/);
});
