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

for (const modifyOwned of [false, true]) {
  test(`Antigravity probe cleanup preserves concurrent edits (modified owned key: ${modifyOwned})`, { skip: !FTS5_AVAILABLE, timeout: 20000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "lore-probe-concurrent-"));
    const shared = path.join(home, ".gemini", "config", "hooks.json");
    const bin = path.join(home, "bin");
    await mkdir(path.dirname(shared), { recursive: true });
    await mkdir(bin);
    await writeFile(shared, JSON.stringify({ existing: { enabled: true } }) + "\n", { mode: 0o600 });
    // A deterministic client double performs the competing write before exiting.
    // No installed host or credentials are used by this test.
    await writeFile(path.join(bin, "agy"), `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("agy test double"); process.exit(0); }
const file = ${JSON.stringify(shared)};
const value = JSON.parse(fs.readFileSync(file, "utf8"));
const key = Object.keys(value).find(name => name.startsWith("lore-verification-"));
if (!key) process.exit(2);
if (${modifyOwned}) value[key] = { changedByConcurrentWriter: true };
value.concurrent = { preserved: true };
fs.writeFileSync(file, JSON.stringify(value));
console.log("Not logged in; /login required");
process.exit(1);
`, { mode: 0o700 });
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/verify-cli-hooks.mjs", import.meta.url)), "antigravity", "--global-hook-probe", "--test-home", home, "--json"], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    const closed = once(child, "close");
    let artifacts;
    try {
      const [code] = await closed;
      assert.equal(code, 0, `${output}\n${errors}`);
      const report = JSON.parse(output);
      artifacts = report.artifacts;
      assert.equal(report.checks.nativeRecall.status, "pending");
      const after = JSON.parse(await readFile(shared, "utf8"));
      assert.deepEqual(after.existing, { enabled: true });
      assert.deepEqual(after.concurrent, { preserved: true });
      const key = Object.keys(after).find(name => name.startsWith("lore-verification-"));
      if (modifyOwned) assert.deepEqual(after[key], { changedByConcurrentWriter: true });
      else assert.equal(key, undefined);
    } finally {
      if (child.exitCode === null) { child.kill("SIGKILL"); await closed; }
      await rm(home, { recursive: true, force: true });
      if (artifacts?.startsWith(path.join(os.tmpdir(), "lore-live-antigravity-"))) await rm(artifacts, { recursive: true, force: true });
    }
  });
}
