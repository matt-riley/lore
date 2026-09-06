import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createPiServerClient } from "../../lib/pi-server-client.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "pi-transport-server.mjs");

function createClient(mode, options = {}) {
  return createPiServerClient({
    command: process.execPath,
    args: [FIXTURE, mode],
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 2_000,
    ...options,
  });
}

test("parses JSON responses split across stdout chunks and UTF-8 boundaries", async () => {
  const client = createClient("normal");

  assert.deepStrictEqual(await client.start(), { ready: "pi-transport-✓" });
  assert.deepStrictEqual(
    await client.request("echo", { message: "split ✓ résumé" }),
    { echo: "split ✓ résumé" },
  );

  await client.close();
});

test("rejects startup when the child exits before the handshake", async () => {
  const client = createClient("fail-start");

  await assert.rejects(
    client.start(),
    /exited before completing request|startup failed|not running/i,
  );
  assert.equal(client.isAlive(), false);
});

test("rejects startup when spawning the child emits an error", async () => {
  const client = createClient("normal", { command: path.join(os.tmpdir(), "missing-lore-node") });

  await assert.rejects(client.start(), /ENOENT|spawn|not found|process error/i);
  assert.equal(client.isAlive(), false);
});

test("rejects pending requests promptly when the child exits early", async () => {
  const client = createClient("exit-after-status");
  await client.start();

  const started = Date.now();
  await assert.rejects(client.request("echo", { message: "never answered" }), /exited|closed|stopped/i);
  assert.ok(Date.now() - started < 1_000, "exit should reject before the request timeout");
  assert.equal(client.isAlive(), false);
});

test("closes by ending stdin after the close acknowledgement drains", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lore-pi-client-"));
  const marker = path.join(dir, "closed");
  const client = createClient("normal", { env: { ...process.env, LORE_PI_TRANSPORT_MARKER: marker } });

  await client.start();
  await client.close();

  assert.equal(existsSync(marker), true);
  assert.equal(readFileSync(marker, "utf8"), `${marker}:eof\n`);
  assert.equal(client.isAlive(), false);
});

test("can start a fresh child after the previous child exits", async () => {
  let launches = 0;
  const client = createPiServerClient({
    command: process.execPath,
    args: [FIXTURE],
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 2_000,
    spawnImpl(command, args, options) {
      launches += 1;
      const mode = launches === 1 ? "exit-after-status" : "normal";
      return spawn(command, [...args, mode], options);
    },
  });

  await client.start();
  await assert.rejects(client.request("echo"), /exited|closed|stopped/i);
  assert.deepStrictEqual(await client.start(), { ready: "pi-transport-✓" });
  assert.equal(launches, 2);
  await client.close();
});
