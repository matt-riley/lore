import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

test("Antigravity global probe refuses the personal home without a dedicated test home", { skip: !FTS5_AVAILABLE, timeout: 15000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-probe-cleanup-"));
  let child;
  let artifacts;
  let closed;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/verify-cli-hooks.mjs", import.meta.url)), "antigravity", "--global-hook-probe"], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    closed = once(child, "close");
    const [code] = await closed;
    artifacts = output.match(/Live antigravity verification artifacts: (.+)/u)?.[1];
    assert.equal(code, 2, errors);
    assert.match(errors, /requires --test-home/u);
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await closed; }
    await rm(home, { recursive: true, force: true });
    if (artifacts?.startsWith(path.join(os.tmpdir(), "lore-live-antigravity-"))) await rm(artifacts, { recursive: true, force: true });
  }
});
