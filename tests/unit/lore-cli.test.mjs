import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../lore-cli.mjs", import.meta.url));

test("lore-cli handles empty stdin gracefully without hanging", () => {
  const result = spawnSync(process.execPath, [cliPath, "hook", "antigravity", "Stop"], {
    input: "",
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout.trim()), { decision: "stop" });
});

test("lore-cli handles whitespace-only stdin gracefully without hanging", () => {
  const result = spawnSync(process.execPath, [cliPath, "hook", "antigravity", "Stop"], {
    input: "   \n\t  \n",
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout.trim()), { decision: "stop" });
});

test("lore-cli handles simulated TTY stdin gracefully without hanging", () => {
  const code = `
    process.stdin.isTTY = true;
    process.stdin[Symbol.asyncIterator] = () => ({
      next: () => new Promise(() => {}),
    });
    process.argv = [process.execPath, ${JSON.stringify(cliPath)}, "hook", "antigravity", "Stop"];
    await import(${JSON.stringify(cliPath)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout.trim()), { decision: "stop" });
});

test("lore-cli rejects input exceeding 1 MiB", () => {
  const largePayload = Buffer.alloc(1024 * 1024 + 10, "a");
  const result = spawnSync(process.execPath, [cliPath, "hook", "antigravity", "Stop"], {
    input: largePayload,
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(result.status, 0);
  assert.deepStrictEqual(JSON.parse(result.stdout.trim()), { decision: "stop" });
  assert.match(result.stderr, /Hook input exceeds 1 MiB/);
});

test("lore-cli reports usage error on missing arguments without hanging", () => {
  const result = spawnSync(process.execPath, [cliPath], {
    input: "{}",
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node lore-cli\.mjs/);
});
