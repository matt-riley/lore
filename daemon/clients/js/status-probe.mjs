// Runtime-agnostic G1 probe: spawns `lored`, performs one Status round trip
// over the Unix socket and exits non-zero on any mismatch. Runs under both
// Node and Bun, which is what Pi uses.
//
//   LORED_BIN=daemon/target/debug/lored node daemon/clients/js/status-probe.mjs
//   LORED_BIN=daemon/target/debug/lored bun  daemon/clients/js/status-probe.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { requestStatus } from "./status-client.mjs";

const binary = process.env.LORED_BIN;
if (!binary) {
  console.error("LORED_BIN must point at a built lored binary");
  process.exit(2);
}

const runtime = typeof Bun === "undefined" ? "node" : "bun";
const dir = mkdtempSync(path.join(tmpdir(), "lore-v2-probe-"));
const socket = path.join(dir, "lored.sock");
const storeId = "store-probe-test";
const child = spawn(binary, ["--socket", socket, "--store-id", storeId], {
  stdio: ["ignore", "ignore", "inherit"],
});

let exitCode = 1;
try {
  for (let attempt = 0; attempt < 500 && !existsSync(socket); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(existsSync(socket), "socket should appear");

  const outcome = await requestStatus(socket);
  assert.equal(outcome.statusCode, 200, outcome.body);
  const payload = JSON.parse(outcome.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.storeId, storeId);
  assert.equal(payload.result.apiMajor, 2);
  assert.equal(payload.result.apiMinor, 0);
  assert.equal(payload.result.storeId, storeId);
  assert.ok(payload.result.capabilities.includes("status.basic"));

  console.log(`probe ok: runtime=${runtime} apiMajor=${payload.result.apiMajor} storeId=${payload.storeId}`);
  exitCode = 0;
} catch (error) {
  console.error(`probe failed under ${runtime}:`, error);
} finally {
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
