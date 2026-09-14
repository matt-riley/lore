import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  classifyOperation,
  dispatchOperation,
  requireDispatchOutcome,
} from "../../lib/runtime/operation-dispatch.mjs";

const CLI = fileURLToPath(new URL("../../lore-cli.mjs", import.meta.url));
const WORKER = fileURLToPath(new URL("../../lore-server.mjs", import.meta.url));

function isolatedHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-operation-dispatch-"));
  writeFileSync(path.join(home, "lore.json"), JSON.stringify({ enabled: true }));
  const env = {
    ...process.env,
    HOME: home,
    LORE_HOME: home,
    LORE_COPILOT_HOME: home,
    LORE_CONFIG: path.join(home, "lore.json"),
    LORE_ENABLED: "true",
    LORE_REPOSITORY: "docs/equiv",
  };
  return { home, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runCli(home, env, args, input = undefined) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: "utf8", input, timeout: 20000 });
}

function runWorker(home, env, request) {
  const result = spawnSync(process.execPath, [WORKER], {
    cwd: home,
    env,
    encoding: "utf8",
    input: `${JSON.stringify(request)}\n`,
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n")
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((message) => message?.id === request.id);
}

test("classifyOperation marks administration previews read-only before storage opens", () => {
  assert.deepEqual(classifyOperation("lore_status", {}), {
    resolved: "lore_status", administration: false, readOnly: false,
  });
  assert.deepEqual(classifyOperation("memory_status", {}), {
    resolved: "lore_status", administration: false, readOnly: false,
  });
  assert.deepEqual(classifyOperation("lore_purge", { repository: "example/repo" }), {
    resolved: "lore_purge", administration: true, readOnly: true,
  });
  assert.deepEqual(classifyOperation("memory_purge", { repository: "example/repo", action: "apply" }), {
    resolved: "lore_purge", administration: true, readOnly: false,
  });
  assert.throws(() => classifyOperation("lore_purge", {}), /explicit selector/);
  assert.throws(() => classifyOperation("lore_correct", {}), /exactly one memoryId/);
});

test("dispatchOperation resolves aliases and reports structured outcomes", async () => {
  const calls = [];
  const tools = [
    { name: "lore_status", handler: async (args, invocation) => { calls.push({ args, invocation }); return "status text"; } },
    { name: "lore_purge", handler: async () => { throw new Error("boom"); } },
  ];

  const ok = await dispatchOperation({
    tools,
    name: "memory_status",
    args: { verbose: false },
    invocation: { sessionId: "session-1", surface: "tool" },
  });
  assert.deepEqual(ok, { ok: true, resolved: "lore_status", text: "status text" });
  assert.deepEqual(calls, [{
    args: { verbose: false },
    invocation: { sessionId: "session-1", surface: "tool" },
  }]);

  const unknown = await dispatchOperation({ tools, name: "not_a_tool" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "unknown_tool");

  const failed = await dispatchOperation({ tools, name: "lore_purge" });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "tool_error");
  assert.equal(failed.error, "boom");

  const unavailable = await dispatchOperation({ tools, name: "lore_status", unavailable: "lore unavailable: disabled" });
  assert.equal(unavailable.code, "unavailable");

  assert.equal(requireDispatchOutcome(unavailable), "lore unavailable: disabled");
  assert.equal(requireDispatchOutcome(unknown, { name: "not_a_tool" }), "lore unavailable: unknown tool not_a_tool");
  assert.throws(() => requireDispatchOutcome(failed), /boom/);
});

test("the same operation is equivalent across the human CLI, protocol CLI, and Pi worker", () => {
  const { home, env, cleanup } = isolatedHome();
  try {
    const seeded = runCli(home, env, ["retain", "--type", "user_preference", "dispatch equivalence quartzmarker"]);
    assert.equal(seeded.status, 0, seeded.stderr);

    const human = runCli(home, env, ["search", "quartzmarker"]);
    assert.equal(human.status, 0, human.stderr);

    const protocol = runCli(home, env, ["tool", "lore_search"], JSON.stringify({ query: "quartzmarker" }));
    assert.equal(protocol.status, 0, protocol.stderr);

    const worker = runWorker(home, env, {
      id: 1,
      method: "tool",
      params: { name: "lore_search", args: { query: "quartzmarker" } },
    });
    assert.equal(worker?.ok, true, JSON.stringify(worker));

    assert.match(human.stdout, /dispatch equivalence quartzmarker/);
    assert.equal(protocol.stdout.trim(), human.stdout.trim(), "protocol CLI and human CLI must agree");
    assert.equal(String(worker.result).trim(), human.stdout.trim(), "Pi worker and human CLI must agree");
  } finally {
    cleanup();
  }
});

test("dispatch failures carry equivalent messages across surfaces", () => {
  const { home, env, cleanup } = isolatedHome();
  try {
    const human = runCli(home, env, ["retain"]);
    assert.notEqual(human.status, 0);
    assert.match(human.stderr, /type must be a non-empty string/);

    const protocol = runCli(home, env, ["tool", "lore_retain"], "{}");
    assert.notEqual(protocol.status, 0);
    assert.match(protocol.stderr, /type must be a non-empty string/);

    const worker = runWorker(home, env, {
      id: 2,
      method: "tool",
      params: { name: "lore_retain", args: {} },
    });
    assert.equal(worker?.ok, false);
    assert.equal(worker.error, "type must be a non-empty string");
  } finally {
    cleanup();
  }
});
