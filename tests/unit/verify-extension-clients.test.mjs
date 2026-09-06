import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts", "verify-extension-clients.mjs");

function run(...args) {
  return execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env: args.includes("--all") ? { ...process.env, PATH: "/nonexistent-lore-test-bin" } : process.env });
}

test("extension verifier mock mode emits labelled lifecycle evidence", () => {
  const evidence = JSON.parse(run("--mock"));
  assert.equal(evidence.schema, "lore.extension-client-certification.v1");
  assert.equal(evidence.mode, "mock");
  assert.ok(evidence.summary.passed >= 4);
  assert.ok(evidence.summary.pending >= 1);
  assert.equal(evidence.summary.failed, 0);
  assert.ok(evidence.outcomes.every((item) => item.evidence === "mocked"));
});

test("extension verifier help documents opt-in live mode", () => {
  const help = run("--help");
  assert.match(help, /--live-host/);
  assert.match(help, /synthetic home/);
});

test("--all includes both fixture and live evidence sets", () => {
  const evidence = JSON.parse(run("--all", "--timeout-ms", "1000"));
  assert.equal(evidence.mode, "all");
  assert.equal(evidence.synthetic, false);
  assert.ok(evidence.outcomes.some((item) => item.evidence === "mocked"));
  assert.ok(evidence.outcomes.some((item) => item.evidence === "live"));
});

test("extension verifier rejects missing option values", () => {
  assert.throws(() => run("--timeout-ms"), /status|failed/i);
  assert.throws(() => run("--output"), /status|failed/i);
});
