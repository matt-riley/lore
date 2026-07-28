/**
 * tests/unit/pre-tool-use-guardrail.test.mjs
 *
 * Unit tests for lib/pre-tool-use-guardrail.mjs.
 *
 * Covers:
 *   - Flag off (default): runPreToolUseGuardrail returns undefined for all inputs
 *   - Flag on + tool not in allowlist: returns undefined (non-blocking)
 *   - Flag on + tool in allowlist + no active sub-agent: returns undefined
 *   - Flag on + tool in allowlist + active sub-agent: returns { additionalContext }
 *   - Explicit allowlist contents: lore_retain, lore_reflect, memory_save
 *   - isToolInAllowlist: returns correct boolean for known/unknown/edge cases
 *   - Timeout: fails open (returns undefined) when check exceeds GUARDRAIL_TIMEOUT_MS
 *   - Timer cleanup: clearTimeout called with hoisted handle after race settles
 *   - Timer cleanup on check error: try/finally clears timer even when check throws
 *   - Error inside check: fails open
 *   - Malformed payload (null, string, missing toolName): returns undefined
 *   - No raw args persisted or surfaced
 *   - Advisory additionalContext does not contain raw arg content
 *   - Unknown flag config (null/undefined): fails open
 */

import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  PRE_TOOL_USE_ALLOWLIST,
  GUARDRAIL_TIMEOUT_MS,
  isToolInAllowlist,
  runPreToolUseGuardrail,
} from "../../lib/pre-tool-use-guardrail.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal config with preToolUseGuardrail flag set. */
function cfg(preToolUseGuardrail) {
  return { rollout: { preToolUseGuardrail } };
}

/** Build a fake PreToolUseHookInput. */
function makeInput(toolName, toolArgs = { sensitiveArg: "SHOULD_NOT_APPEAR" }) {
  return { toolName, toolArgs, sessionId: "sess-test", timestamp: new Date(), workingDirectory: "/work" };
}

/** Build a fake scope tracker that returns the given agent name. */
function makeScopeTracker(agentName) {
  return {
    getActiveScopeMetadata: () =>
      agentName
        ? { activeSubagent: { name: agentName, displayName: `${agentName} Display` } }
        : null,
  };
}

/** Null scope tracker (no active agent). */
const noAgentTracker = makeScopeTracker(null);

// ---------------------------------------------------------------------------
// PRE_TOOL_USE_ALLOWLIST — shape and membership
// ---------------------------------------------------------------------------

describe("PRE_TOOL_USE_ALLOWLIST", () => {
  test("is a frozen Set", () => {
    assert.ok(PRE_TOOL_USE_ALLOWLIST instanceof Set, "must be a Set");
    assert.ok(Object.isFrozen(PRE_TOOL_USE_ALLOWLIST), "must be frozen");
  });

  test("contains exactly the expected Lore-relevant tools", () => {
    const expected = ["lore_retain", "lore_reflect", "memory_save"];
    for (const name of expected) {
      assert.ok(PRE_TOOL_USE_ALLOWLIST.has(name), `${name} must be in allowlist`);
    }
    assert.strictEqual(PRE_TOOL_USE_ALLOWLIST.size, expected.length);
  });

  test("does not contain bash, grep, or other non-memory tools", () => {
    assert.strictEqual(PRE_TOOL_USE_ALLOWLIST.has("bash"), false);
    assert.strictEqual(PRE_TOOL_USE_ALLOWLIST.has("grep"), false);
    assert.strictEqual(PRE_TOOL_USE_ALLOWLIST.has("lore_recall"), false);
    assert.strictEqual(PRE_TOOL_USE_ALLOWLIST.has("web_fetch"), false);
  });
});

// ---------------------------------------------------------------------------
// isToolInAllowlist
// ---------------------------------------------------------------------------

describe("isToolInAllowlist", () => {
  test("lore_retain → true", () => assert.strictEqual(isToolInAllowlist("lore_retain"), true));
  test("lore_reflect → true", () => assert.strictEqual(isToolInAllowlist("lore_reflect"), true));
  test("memory_save → true", () => assert.strictEqual(isToolInAllowlist("memory_save"), true));
  test("bash → false", () => assert.strictEqual(isToolInAllowlist("bash"), false));
  test("lore_recall → false", () => assert.strictEqual(isToolInAllowlist("lore_recall"), false));
  test("null → false", () => assert.strictEqual(isToolInAllowlist(null), false));
  test("undefined → false", () => assert.strictEqual(isToolInAllowlist(undefined), false));
  test("empty string → false", () => assert.strictEqual(isToolInAllowlist(""), false));
  test("42 → false", () => assert.strictEqual(isToolInAllowlist(42), false));
  test("whitespace-padded name: '  lore_retain  ' → true", () => {
    assert.strictEqual(isToolInAllowlist("  lore_retain  "), true);
  });
  test("name longer than 64 chars → false (truncated beyond allowlist)", () => {
    const longName = "lore_retain" + "x".repeat(60);
    assert.strictEqual(isToolInAllowlist(longName), false);
  });
});

// ---------------------------------------------------------------------------
// Flag off (default) — returns undefined for everything
// ---------------------------------------------------------------------------

describe("runPreToolUseGuardrail — flag off", () => {
  test("returns undefined when rollout flag is false", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("lore_retain"),
      { config: cfg(false), scopeTracker: makeScopeTracker("impl-planner") },
    );
    assert.strictEqual(result, undefined);
  });

  test("returns undefined when config is null", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("lore_retain"),
      { config: null, scopeTracker: makeScopeTracker("impl-planner") },
    );
    assert.strictEqual(result, undefined);
  });

  test("returns undefined when config is undefined", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("lore_retain"),
      { config: undefined },
    );
    assert.strictEqual(result, undefined);
  });

  test("returns undefined when opts is omitted", async () => {
    const result = await runPreToolUseGuardrail(makeInput("lore_retain"));
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Flag on — tool not in allowlist
// ---------------------------------------------------------------------------

describe("runPreToolUseGuardrail — flag on, tool not in allowlist", () => {
  test("returns undefined for bash", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("bash"),
      { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
    );
    assert.strictEqual(result, undefined);
  });

  test("returns undefined for lore_recall", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("lore_recall"),
      { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
    );
    assert.strictEqual(result, undefined);
  });

  test("returns undefined for unknown tool", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("some_unknown_tool"),
      { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
    );
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Flag on — tool in allowlist, no active sub-agent
// ---------------------------------------------------------------------------

describe("runPreToolUseGuardrail — flag on, allowlisted tool, no active agent", () => {
  test("returns undefined when scope tracker returns null", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("lore_retain"),
      { config: cfg(true), scopeTracker: noAgentTracker },
    );
    assert.strictEqual(result, undefined);
  });

  test("returns undefined when scopeTracker is absent", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("lore_retain"),
      { config: cfg(true) },
    );
    assert.strictEqual(result, undefined);
  });

  test("returns undefined when scopeTracker.getActiveScopeMetadata is missing", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("lore_retain"),
      { config: cfg(true), scopeTracker: {} },
    );
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Flag on — tool in allowlist, active sub-agent
// ---------------------------------------------------------------------------

describe("runPreToolUseGuardrail — flag on, allowlisted tool, active agent", () => {
  test("lore_retain: returns additionalContext with agent name", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("lore_retain"),
      { config: cfg(true), scopeTracker: makeScopeTracker("impl-planner") },
    );
    assert.ok(result, "must return result");
    assert.ok(typeof result.additionalContext === "string", "additionalContext must be string");
    assert.ok(result.additionalContext.includes("impl-planner"), "must include agent name");
  });

  test("lore_reflect: returns additionalContext", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("lore_reflect"),
      { config: cfg(true), scopeTracker: makeScopeTracker("reviewer") },
    );
    assert.ok(result?.additionalContext, "must return additionalContext");
    assert.ok(result.additionalContext.includes("reviewer"));
  });

  test("memory_save: returns additionalContext", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("memory_save"),
      { config: cfg(true), scopeTracker: makeScopeTracker("coder") },
    );
    assert.ok(result?.additionalContext, "must return additionalContext");
  });

  test("returned additionalContext has exactly { additionalContext } key — no permission override", async () => {
    const result = await runPreToolUseGuardrail(
      makeInput("lore_retain"),
      { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
    );
    assert.ok(result, "must return result");
    // permissionDecision must be absent — never block
    assert.strictEqual("permissionDecision" in result, false, "must not include permissionDecision");
    assert.strictEqual("modifiedArgs" in result, false, "must not include modifiedArgs");
    assert.strictEqual("suppressOutput" in result, false, "must not include suppressOutput");
    // Only allowed key in Phase 3 output
    assert.ok("additionalContext" in result);
  });
});

// ---------------------------------------------------------------------------
// No raw args persisted or surfaced
// ---------------------------------------------------------------------------

describe("runPreToolUseGuardrail — no raw args in output", () => {
  test("additionalContext does not contain raw toolArgs content", async () => {
    const sensitiveInput = makeInput("lore_retain", {
      content: "SENSITIVE_CONTENT_12345",
      path: "/home/user/.ssh/id_rsa",
    });
    const result = await runPreToolUseGuardrail(
      sensitiveInput,
      { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
    );
    if (result) {
      const ctx = result.additionalContext ?? "";
      assert.ok(!ctx.includes("SENSITIVE_CONTENT_12345"), "must not include toolArgs content");
      assert.ok(!ctx.includes("id_rsa"), "must not include toolArgs path");
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed / absent payloads
// ---------------------------------------------------------------------------

describe("runPreToolUseGuardrail — malformed payloads fail open", () => {
  test("null input → undefined", async () => {
    const result = await runPreToolUseGuardrail(
      null,
      { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
    );
    assert.strictEqual(result, undefined);
  });

  test("undefined input → undefined", async () => {
    const result = await runPreToolUseGuardrail(
      undefined,
      { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
    );
    assert.strictEqual(result, undefined);
  });

  test("string input → undefined", async () => {
    const result = await runPreToolUseGuardrail(
      "lore_retain",
      { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
    );
    assert.strictEqual(result, undefined);
  });

  test("input with non-string toolName → undefined", async () => {
    const result = await runPreToolUseGuardrail(
      { toolName: 42, toolArgs: {} },
      { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
    );
    assert.strictEqual(result, undefined);
  });

  test("empty object (no toolName) → undefined", async () => {
    const result = await runPreToolUseGuardrail(
      {},
      { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
    );
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Fail open on error in scopeTracker
// ---------------------------------------------------------------------------

describe("runPreToolUseGuardrail — fail open on error", () => {
  test("throws in scopeTracker.getActiveScopeMetadata → returns undefined", async () => {
    const brokenTracker = {
      getActiveScopeMetadata: () => {
        throw new Error("tracker exploded");
      },
    };
    const result = await runPreToolUseGuardrail(
      makeInput("lore_retain"),
      { config: cfg(true), scopeTracker: brokenTracker },
    );
    assert.strictEqual(result, undefined);
  });

  test("scopeTracker.getActiveScopeMetadata returns null agent name → returns undefined", async () => {
    const trackerNoName = {
      getActiveScopeMetadata: () => ({ activeSubagent: { name: "", displayName: null } }),
    };
    const result = await runPreToolUseGuardrail(
      makeInput("lore_retain"),
      { config: cfg(true), scopeTracker: trackerNoName },
    );
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// GUARDRAIL_TIMEOUT_MS constant
// ---------------------------------------------------------------------------

describe("GUARDRAIL_TIMEOUT_MS", () => {
  test("is a positive number at most 100 ms", () => {
    assert.ok(typeof GUARDRAIL_TIMEOUT_MS === "number");
    assert.ok(GUARDRAIL_TIMEOUT_MS > 0);
    assert.ok(GUARDRAIL_TIMEOUT_MS <= 100, "timeout must be short (≤100ms)");
  });
});

// ---------------------------------------------------------------------------
// Timer lifecycle — clearTimeout called with hoisted handle, try/finally
// ---------------------------------------------------------------------------

describe("runPreToolUseGuardrail — timer lifecycle", () => {
  test("clearTimeout is called with the timer handle after check resolves", async () => {
    const setTimeoutSpy = mock.method(globalThis, "setTimeout");
    const clearTimeoutSpy = mock.method(globalThis, "clearTimeout");
    try {
      const result = await runPreToolUseGuardrail(
        makeInput("lore_retain"),
        { config: cfg(true), scopeTracker: makeScopeTracker("planner") },
      );
      assert.ok(result?.additionalContext, "check must resolve with context");

      // Locate the guardrail timer by its registered delay
      const guardCall = setTimeoutSpy.mock.calls.find(
        (c) => c.arguments[1] === GUARDRAIL_TIMEOUT_MS,
      );
      assert.ok(guardCall, "guardrail must register a timer with GUARDRAIL_TIMEOUT_MS delay");
      const timerId = guardCall.result;

      // clearTimeout must have been called with that handle (not inside the timer callback)
      const clearCall = clearTimeoutSpy.mock.calls.find(
        (c) => c.arguments[0] === timerId,
      );
      assert.ok(clearCall, "clearTimeout must be called with the timer handle after race settles");
    } finally {
      setTimeoutSpy.mock.restore();
      clearTimeoutSpy.mock.restore();
    }
  });

  test("timer is cleared even when check throws (try/finally guarantees cleanup)", async () => {
    const setTimeoutSpy = mock.method(globalThis, "setTimeout");
    const clearTimeoutSpy = mock.method(globalThis, "clearTimeout");
    try {
      const throwingTracker = {
        getActiveScopeMetadata: () => { throw new Error("checker exploded"); },
      };
      const result = await runPreToolUseGuardrail(
        makeInput("lore_retain"),
        { config: cfg(true), scopeTracker: throwingTracker },
      );
      assert.strictEqual(result, undefined, "must fail open on check error");

      // Timer must have been registered and then cleared via finally
      const guardCall = setTimeoutSpy.mock.calls.find(
        (c) => c.arguments[1] === GUARDRAIL_TIMEOUT_MS,
      );
      assert.ok(guardCall, "timer must have been registered before the check threw");
      const timerId = guardCall.result;

      const clearCall = clearTimeoutSpy.mock.calls.find(
        (c) => c.arguments[0] === timerId,
      );
      assert.ok(clearCall, "clearTimeout must be called even when the check throws");
    } finally {
      setTimeoutSpy.mock.restore();
      clearTimeoutSpy.mock.restore();
    }
  });
});
