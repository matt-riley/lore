// The daemon's endpoint comes from its config, never from a client-side
// environment variable: an inherited LORE_V2_SOCKET (set by shells and host
// adapters) must not move the daemon or collide with an installed service.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loredBinary, startDaemon } from "./harness.mjs";

async function waitForSocket(socket) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(socket)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("daemon never started listening");
}

test("an inherited LORE_V2_SOCKET does not move the daemon endpoint", async (t) => {
  const elsewhere = mkdtempSync(path.join(tmpdir(), "lore-elsewhere-"));
  const decoy = path.join(elsewhere, "decoy.sock");
  const daemon = startDaemon({ env: { LORE_V2_SOCKET: decoy } });
  t.after(async () => {
    await daemon.stop();
    daemon.cleanup();
    rmSync(elsewhere, { recursive: true, force: true });
  });

  await waitForSocket(daemon.socket);
  assert.ok(existsSync(daemon.socket), "the config socket is the one that exists");
  assert.equal(existsSync(decoy), false, "the client-side variable is ignored");
  assert.ok(loredBinary(), "the test ran against a built binary");
});
