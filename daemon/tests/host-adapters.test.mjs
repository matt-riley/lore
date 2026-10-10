// Host adapter proofs: Pi and Copilot registration, tool dispatch, capability
// refusal, cancellation and the uncertain-write journal.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startDaemon } from "./harness.mjs";
import { requestStatus } from "../clients/js/status-client.mjs";
import { MODEL_TOOL_NAMES } from "../clients/js/model-tools.mjs";
import { createHostSession, isRetryableTransportError } from "../clients/js/host-session.mjs";
import { registerPiV2, parseSlashArgs } from "../clients/pi/register.mjs";
import createLoreV2Extension, {
  buildCopilotHooks,
  buildCopilotTools,
} from "../clients/copilot/extension.mjs";
import { resolveSocketPath } from "../clients/js/endpoint.mjs";

function fakePi() {
  const tools = new Map();
  const commands = new Map();
  const hooks = new Map();
  return {
    tools,
    commands,
    hooks,
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      hooks.set(event, handler);
    },
  };
}

async function waitForSocket(socket) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await requestStatus(socket, { clientId: "test.host.wait" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("daemon never started listening");
}

function toolText(result) {
  if (typeof result === "string") return result;
  const blocks = result?.content ?? [];
  return blocks.map((block) => block?.text ?? "").join("");
}

async function withDaemon(t, options = {}) {
  const daemon = startDaemon({ dir: mkdtempSync(path.join(tmpdir(), "lore-host-")) });
  await waitForSocket(daemon.socket);
  t.after(async () => {
    await daemon.stop();
    daemon.cleanup();
  });
  return {
    daemon,
    options: { socketPath: daemon.socket, ...options },
  };
}

test("pi registration exposes exactly the nine canonical tools", async (t) => {
  const { options } = await withDaemon(t);
  const pi = fakePi();
  const session = registerPiV2(pi, options);
  assert.deepEqual([...pi.tools.keys()].sort(), [...MODEL_TOOL_NAMES].sort());
  assert.ok(pi.commands.has("lore"));
  assert.ok(pi.hooks.has("session_start"));
  assert.ok(pi.hooks.has("session_shutdown"));

  const retainedRaw = await pi.tools.get("lore_retain").execute(null, {
    content: "Host adapters talk to the daemon over the socket.",
    kind: "note",
  });
  // Pi requires content blocks: a bare string renders as nothing.
  assert.equal(retainedRaw?.content?.[0]?.type, "text");
  const retained = toolText(retainedRaw);
  assert.match(retained, /Saved memory/);

  const recalled = toolText(
    await pi.tools.get("lore_recall").execute(null, { query: "host adapters socket" }),
  );
  assert.match(recalled, /Host adapters talk to the daemon/);

  const status = toolText(await pi.tools.get("lore_status").execute(null, {}));
  assert.match(status, /lore ready/);

  const validate = toolText(await pi.tools.get("lore_validate").execute(null, {}));
  assert.match(validate, /Validation passed/);

  await session.shutdownAll();
});

test("copilot extension exposes the same nine tools and slash prompts", async (t) => {
  const { options } = await withDaemon(t);
  const extension = createLoreV2Extension(options);
  assert.deepEqual(
    extension.tools.map((tool) => tool.name).sort(),
    [...MODEL_TOOL_NAMES].sort(),
  );

  const onboarded = await extension.tools
    .find((tool) => tool.name === "lore_onboard")
    .handler({ userName: "Matt", assistantName: "Felix" }, { sessionId: "s1" });
  assert.match(onboarded, /Onboarded/);

  const retained = await extension.tools
    .find((tool) => tool.name === "lore_retain")
    .handler({ content: "Copilot uses the same adapter.", kind: "note" }, { sessionId: "s1" });
  assert.match(retained, /Saved memory/);

  const hooks = buildCopilotHooks(extension.session);
  const slash = await hooks.onUserPromptSubmitted(
    { prompt: "/lore search Copilot adapter" },
    { sessionId: "s1" },
  );
  assert.match(slash.response, /Copilot uses the same adapter/);

  const unknown = await hooks.onUserPromptSubmitted(
    { prompt: "/lore frobnicate" },
    { sessionId: "s1" },
  );
  assert.match(unknown.response, /verbs are/);

  const retries = await hooks.onUserPromptSubmitted(
    { prompt: "/lore retries" },
    { sessionId: "s1" },
  );
  assert.match(retries.response, /no uncertain writes pending/);

  await hooks.onSessionEnd({}, { sessionId: "s1" });
});

test("capability refusal is explicit when the daemon does not advertise it", async () => {
  const fakeClient = {
    negotiated: async () => ({ storeId: "store-test", capabilities: ["status.basic"] }),
    requireCapability: async (name) => {
      const error = new Error(`daemon does not advertise capability ${name}`);
      error.reason = "CAPABILITY_UNAVAILABLE";
      throw error;
    },
    call: async () => {
      throw new Error("must not be called");
    },
  };
  const messages = [];
  const session = createHostSession({
    socketPath: "/tmp/unused.sock",
    createClient: () => fakeClient,
    notify: (message) => messages.push(message),
  });
  await assert.rejects(
    () => session.invokeTool("lore_search", { query: "anything" }, { sessionId: "s" }),
    /does not advertise capability search\.browse/,
  );
  // The warning is deduplicated per category.
  await assert.rejects(() =>
    session.invokeTool("lore_search", { query: "again" }, { sessionId: "s" }),
  );
  assert.equal(messages.length, 1);
});

test("one bounded retry reuses the idempotency key and resolves the journal", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-journal-"));
  const journalPath = path.join(dir, "uncertain-writes.json");
  let attempts = 0;
  const seenKeys = [];
  const fakeClient = {
    negotiated: async () => ({ storeId: "store-test", capabilities: [] }),
    requireCapability: async () => {},
    call: async (_route, params) => {
      attempts += 1;
      seenKeys.push(params.idempotencyKey);
      if (attempts === 1) {
        const error = new Error("connect ECONNREFUSED");
        error.code = "ECONNREFUSED";
        throw error;
      }
      return { memoryId: "mem-1" };
    },
  };
  const session = createHostSession({
    socketPath: "/tmp/unused.sock",
    createClient: () => fakeClient,
    journalPath,
  });
  const result = await session.invokeTool(
    "lore_retain",
    { content: "Retried write." },
    { sessionId: "s" },
  );
  assert.equal(result.memoryId, "mem-1");
  assert.equal(attempts, 2);
  assert.equal(seenKeys[0], seenKeys[1]);
  assert.deepEqual(session.retries(), []);
  const persisted = JSON.parse(readFileSync(journalPath, "utf8"));
  const entry = Object.values(persisted.entries)[0];
  assert.equal(entry.resolved, true);
  assert.equal(entry.params, null);
  rmSync(dir, { recursive: true, force: true });
});

test("a non-transport failure keeps the journal payload for explicit retry", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-journal-"));
  const journalPath = path.join(dir, "uncertain-writes.json");
  const fakeClient = {
    negotiated: async () => ({ storeId: "store-test", capabilities: [] }),
    requireCapability: async () => {},
    call: async () => {
      const error = new Error("PREVIEW_STALE: preview again");
      error.reason = "PREVIEW_STALE";
      throw error;
    },
  };
  const session = createHostSession({
    socketPath: "/tmp/unused.sock",
    createClient: () => fakeClient,
    journalPath,
  });
  await assert.rejects(
    () => session.invokeTool("lore_retain", { content: "Uncertain." }, { sessionId: "s" }),
    /PREVIEW_STALE/,
  );
  const pending = session.retries();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operation, "lore_retain");
  assert.equal(pending[0].hasPayload, true);
  rmSync(dir, { recursive: true, force: true });
});

test("journal capacity rejects a write before dispatch", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-journal-"));
  const journalPath = path.join(dir, "uncertain-writes.json");
  let dispatched = 0;
  const fakeClient = {
    negotiated: async () => ({ storeId: "store-test", capabilities: [] }),
    requireCapability: async () => {},
    call: async () => {
      dispatched += 1;
      const error = new Error("timed out");
      throw error;
    },
  };
  const session = createHostSession({
    socketPath: "/tmp/unused.sock",
    createClient: () => fakeClient,
    journalPath,
    journalCapacity: 1,
  });
  await assert.rejects(() =>
    session.invokeTool("lore_retain", { content: "first" }, { sessionId: "s" }),
  );
  await assert.rejects(
    () => session.invokeTool("lore_retain", { content: "second" }, { sessionId: "s" }),
    /journal is full/,
  );
  // The first write was dispatched (and retried once); the second never was.
  assert.equal(dispatched, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("session shutdown aborts in-flight work", async () => {
  const fakeClient = {
    negotiated: async () => ({ storeId: "store-test", capabilities: [] }),
    requireCapability: async () => {},
    call: async (_route, _params, { signal } = {}) =>
      new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
          return;
        }
        signal?.addEventListener("abort", () => {
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  };
  const session = createHostSession({
    socketPath: "/tmp/unused.sock",
    createClient: () => fakeClient,
  });
  const inflight = session.invokeTool("lore_recall", { query: "hang" }, { sessionId: "s" });
  await session.shutdownSession("s");
  await assert.rejects(() => inflight, /aborted/);
});

test("slash parsing and transport classification stay host-agnostic", () => {
  assert.deepEqual(parseSlashArgs(""), { verb: "status", rest: "" });
  assert.deepEqual(parseSlashArgs("recall why is the sky blue"), {
    verb: "recall",
    rest: "why is the sky blue",
  });
  assert.equal(isRetryableTransportError(Object.assign(new Error("x"), { code: "EPIPE" })), true);
  assert.equal(isRetryableTransportError(Object.assign(new Error("x"), { reason: "PREVIEW_STALE" })), false);
});

test("journal file is created with restrictive permissions on first write", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-journal-"));
  const journalPath = path.join(dir, "uncertain-writes.json");
  const fakeClient = {
    negotiated: async () => ({ storeId: "store-test", capabilities: [] }),
    requireCapability: async () => {},
    call: async () => ({ memoryId: "mem-1" }),
  };
  const session = createHostSession({
    socketPath: "/tmp/unused.sock",
    createClient: () => fakeClient,
    journalPath,
  });
  await session.invokeTool("lore_retain", { content: "Permissions." }, { sessionId: "s" });
  assert.ok(existsSync(journalPath));
  const mode = readFileSync(journalPath, "utf8").length > 0;
  assert.ok(mode);
  rmSync(dir, { recursive: true, force: true });
});

test("copilot injects session and prompt context from the daemon", async (t) => {
  const { options } = await withDaemon(t);
  const extension = createLoreV2Extension(options);
  await extension.tools
    .find((tool) => tool.name === "lore_retain")
    .handler(
      { content: "Always run the schema check before copying rows.", kind: "directive", scope: "global" },
      { sessionId: "c1" },
    );

  const capsule = await extension.hooks.onSessionStart(
    { cwd: process.cwd() },
    { sessionId: "c1" },
  );
  assert.match(capsule?.additionalContext ?? "", /<lore_context>/);
  assert.match(capsule.additionalContext, /Session context injected by Lore/);

  const prompt = await extension.hooks.onUserPromptSubmitted(
    { prompt: "schema check", cwd: process.cwd() },
    { sessionId: "c1" },
  );
  assert.match(prompt?.additionalContext ?? "", /schema check/i);

  // The /lore command still answers instead of injecting.
  const slash = await extension.hooks.onUserPromptSubmitted(
    { prompt: "/lore status", cwd: process.cwd() },
    { sessionId: "c1" },
  );
  assert.match(slash?.response ?? "", /lore ready/);

  // A host that passes no socket still resolves the installed config.
  const resolved = resolveSocketPath({ HOME: path.join(tmpdir(), "lore-no-such-home") });
  assert.equal(resolved, null, "an unresolved endpoint registers nothing");
});

test("pi injects session and prompt context from the daemon and fails open", async (t) => {
  const { options } = await withDaemon(t);
  const pi = fakePi();
  registerPiV2(pi, options);

  // A directive is always part of the mandatory context, so the capsule has
  // something to inject even in a fresh store.
  const retained = toolText(
    await pi.tools.get("lore_retain").execute(null, {
      content: "Always run the schema check before copying rows.",
      kind: "directive",
      scope: "global",
    }),
  );
  assert.match(retained, /Saved memory/);
  await pi.tools.get("lore_retain").execute(null, {
    content: "Prefer small pure functions over clever abstractions.",
    kind: "note",
    scope: "global",
  });

  // Session start returns a non-displayed context capsule.
  const capsule = await pi.hooks.get("session_start")({}, { sessionId: "s1", cwd: process.cwd() });
  assert.ok(capsule?.message?.content, "session_start injects context");
  assert.equal(capsule.message.display, false);
  assert.equal(capsule.message.lorePhase, "session_start");
  assert.match(capsule.message.content, /<lore_context>/);
  assert.match(capsule.message.content, /Session context injected by Lore/);

  // A prompt recalls memory and wraps it once.
  const prompt = await pi.hooks.get("before_agent_start")(
    { prompt: "pure functions" },
    { sessionId: "s1", cwd: process.cwd() },
  );
  assert.match(prompt?.message?.content ?? "", /pure functions/i);

  // The same prompt is not injected twice for one session.
  const repeat = await pi.hooks.get("before_agent_start")(
    { prompt: "pure functions" },
    { sessionId: "s1", cwd: process.cwd() },
  );
  assert.equal(repeat, undefined, "identical prompts are not re-injected");

  // A different prompt does inject again.
  const other = await pi.hooks.get("before_agent_start")(
    { prompt: "abstractions" },
    { sessionId: "s1", cwd: process.cwd() },
  );
  assert.ok(other?.message?.content, "a new prompt injects again");

  // A dead daemon must never break the host.
  const dead = fakePi();
  registerPiV2(dead, { socketPath: path.join(tmpdir(), "lore-missing", "lored.sock") });
  const offline = await dead.hooks.get("before_agent_start")(
    { prompt: "anything" },
    { sessionId: "s2", cwd: process.cwd() },
  );
  assert.equal(offline, undefined, "injection fails open when the daemon is gone");
});
