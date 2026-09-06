import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

test("interrupting a live Antigravity probe removes only its temporary global hook", { skip: !FTS5_AVAILABLE, timeout: 15000 }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-probe-cleanup-"));
  let child;
  let artifacts;
  let closed;
  try {
    const bin = path.join(home, "bin");
    const configDirectory = path.join(home, ".gemini", "config");
    await mkdir(bin);
    await mkdir(configDirectory, { recursive: true });
    const hooksPath = path.join(configDirectory, "hooks.json");
    const original = '{"other":{"Stop":[]}}\n';
    await writeFile(hooksPath, original);
    await writeFile(path.join(bin, "agy"), "#!/bin/sh\nkill -TERM \"$PPID\"\n", { mode: 0o700 });
    child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/verify-cli-hooks.mjs", import.meta.url)), "antigravity", "--global-hook-probe"], {
      env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    closed = once(child, "close");
    const [code] = await closed;
    artifacts = output.match(/Live antigravity verification artifacts: (.+)/u)?.[1];
    assert.equal(code, 143, errors);
    assert.equal(await readFile(hooksPath, "utf8"), original);
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await closed; }
    await rm(home, { recursive: true, force: true });
    if (artifacts?.startsWith(path.join(os.tmpdir(), "lore-live-antigravity-"))) await rm(artifacts, { recursive: true, force: true });
  }
});
