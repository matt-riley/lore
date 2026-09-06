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

test("Antigravity global probe preserves concurrent config edits during cleanup", { skip: !FTS5_AVAILABLE, timeout: 20000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-probe-concurrent-"));
  const shared = path.join(home, ".gemini", "config", "hooks.json");
  await mkdir(path.dirname(shared), { recursive: true });
  await writeFile(shared, JSON.stringify({ existing: { enabled: true } }) + "\n", { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/verify-cli-hooks.mjs", import.meta.url)), "antigravity", "--global-hook-probe", "--test-home", home, "--json"], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let mutated = false;
  const poll = setInterval(async () => {
    try {
      const current = JSON.parse(await readFile(shared, "utf8"));
      const key = Object.keys(current).find((name) => name.startsWith("lore-verification-"));
      if (key && !mutated) {
        current[key] = { changedByConcurrentWriter: true };
        current.concurrent = { preserved: true };
        await writeFile(shared, JSON.stringify(current) + "\n", { mode: 0o600 });
        mutated = true;
      }
    } catch { /* file is not created yet or probe is finishing */ }
  }, 5);
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.equal(mutated, true, "test must mutate the probe key while it is live");
    const after = JSON.parse(await readFile(shared, "utf8"));
    assert.deepEqual(after.existing, { enabled: true });
    assert.deepEqual(after.concurrent, { preserved: true });
    assert.deepEqual(after[Object.keys(after).find((name) => name.startsWith("lore-verification-"))], { changedByConcurrentWriter: true });
  } finally {
    clearInterval(poll);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});
