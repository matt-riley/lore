// Runs the Node client proof against a real lored binary.
//
//   LORED_BIN=daemon/target/debug/lored node --test daemon/clients/node/status-client.test.mjs
//
// Skips when LORED_BIN is not set so the default Node test run stays Rust-free.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { requestStatus } from "./status-client.mjs";

test("node client exchanges status with lored", { skip: !process.env.LORED_BIN }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-v2-node-"));
  const socket = path.join(dir, "lored.sock");
  const child = spawn(process.env.LORED_BIN, ["--socket", socket, "--store-id", "store-node-test"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    for (let attempt = 0; attempt < 500 && !existsSync(socket); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(existsSync(socket), "socket should appear");

    const outcome = await requestStatus(socket);
    assert.equal(outcome.statusCode, 200);
    const payload = JSON.parse(outcome.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.storeId, "store-node-test");
    assert.equal(payload.result.apiMajor, 2);
    assert.equal(payload.result.storeId, "store-node-test");
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
