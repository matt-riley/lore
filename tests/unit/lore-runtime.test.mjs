import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createLoreSession } from "../../lib/runtime/lore-runtime.mjs";
import {
  COPILOT_MODEL_LIST_SHRINK_READY,
  DEFAULT_MODEL_TOOL_NAMES,
  listCopilotJoinTools,
  listModelTools,
} from "../../lib/runtime/tool-registry.mjs";
import { resolveLoreToolName } from "../../lib/capabilities/capability-manifest.mjs";
import { createTempHome } from "../helpers/temp-home.mjs";
import { enabledConfig } from "../helpers/fixture-config.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function passingRuntimeCheck() {
  return async () => ({ ok: true, diagnostics: [] });
}

describe("createLoreSession", () => {
  test("never returns null; disabled sessions are fail-open stubs", async () => {
    const session = await createLoreSession({
      client: "copilot",
      surface: "hook",
      config: { enabled: false, configPath: "/tmp/lore.json" },
      checkRuntime: passingRuntimeCheck(),
    });
    assert.notEqual(session, null);
    assert.equal(session.initialized, false);
    assert.equal(session.enabled, false);
    assert.equal(session.client, "copilot");
    assert.equal(session.db, null);
    assert.deepEqual(await session.handleLifecycle("session_start"), {});
    assert.match(await session.dispatchTool("lore_status", {}), /lore unavailable/);
    assert.match(await session.dispatchSlash("status"), /lore unavailable/);
    session.close();
  });

  test("runtime preflight failure is a fail-open stub", async () => {
    const session = await createLoreSession({
      client: "copilot",
      checkRuntime: async () => ({ ok: false, diagnostics: ["node:sqlite is unavailable"] }),
    });
    assert.notEqual(session, null);
    assert.equal(session.initialized, false);
    assert.match(await session.dispatchTool("lore_recall", { prompt: "x" }), /lore unavailable: node:sqlite is unavailable/);
    session.close();
  });

  test("enabled Copilot sessions dispatch tools and slash verbs", { skip: SKIP_NO_FTS5 }, async () => {
    const { home, cleanup } = createTempHome({ configOverrides: { enabled: true } });
    try {
      const session = await createLoreSession({
        client: "copilot",
        surface: "hook",
        cwd: home,
        config: enabledConfig(home),
        checkRuntime: passingRuntimeCheck(),
      });
      assert.equal(session.initialized, true);
      assert.equal(session.enabled, true);
      assert.equal(session.client, "copilot");
      assert.notEqual(session.db, null);

      const status = await session.dispatchTool("lore_status", {}, { surface: "tool" });
      assert.match(String(status), /enabled: true/);

      const slash = await session.dispatchSlash("status", { surface: "slash" });
      assert.match(String(slash), /enabled: true/);

      const lifecycle = await session.handleLifecycle("session_start", { prompt: "" });
      assert.equal(typeof lifecycle, "object");
      session.close();
      assert.equal(session.initialized, false);
    } finally {
      cleanup();
    }
  });
});

describe("tool registry", () => {
  test("listModelTools is the intended nine canonical names in order", () => {
    const tools = listModelTools({ getRuntime: async () => ({}) });
    assert.deepEqual(tools.map((tool) => tool.name), [...DEFAULT_MODEL_TOOL_NAMES]);
    assert.equal(tools.length, 9);
  });

  test("Copilot join tools shrink to the canonical nine after the /lore gate", () => {
    assert.equal(COPILOT_MODEL_LIST_SHRINK_READY, true);
    const joined = listCopilotJoinTools({ getRuntime: async () => ({}) });
    assert.deepEqual(joined.map((tool) => tool.name), [...DEFAULT_MODEL_TOOL_NAMES]);
  });

  test("legacy Copilot tool names remain input aliases after the shrink", () => {
    for (const [legacy, canonical] of [
      ["memory_save", "lore_retain"],
      ["memory_search", "lore_search"],
      ["memory_forget", "lore_forget"],
      ["memory_status", "lore_status"],
      ["memory_explain", "lore_explain"],
      ["memory_validate", "lore_validate"],
      ["memory_correct", "lore_correct"],
      ["memory_repair", "lore_repair"],
      ["memory_purge", "lore_purge"],
    ]) {
      assert.equal(resolveLoreToolName(legacy), canonical, `${legacy} must resolve to ${canonical}`);
    }
  });
});
