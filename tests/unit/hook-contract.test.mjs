import assert from "node:assert";
import { buildLoreHooks, LORE_HOOK_NAMES } from "../../lib/hook-registration.mjs";

// Programmatic unit tests for the hook helper and canonical contract
const run = async () => {
  // canonical contract
  assert(Array.isArray(LORE_HOOK_NAMES), "LORE_HOOK_NAMES should be an array");
  assert.strictEqual(LORE_HOOK_NAMES.length, 7, "There must be seven canonical hooks");
  assert(LORE_HOOK_NAMES.includes("onPreMcpToolCall"), "onPreMcpToolCall must be part of the canonical set");
  assert(!LORE_HOOK_NAMES.includes("onEvent"), "onEvent must NOT be part of the canonical set");

  // prepare handlers with mixed values
  const f1 = () => 1;
  const f2 = function () { return 2; };
  const handlers = {
    onSessionStart: f1,
    onPreToolUse: f2,
    onPreMcpToolCall: () => "ok",
    onEvent: () => "should be rejected",
    onSessionEnd: undefined,
    onUserPromptSubmitted: "not-a-function",
    unknownHook: () => {},
  };

  const built = buildLoreHooks(handlers);

  // should only include canonical names with function values
  assert.strictEqual(typeof built.onSessionStart, "function");
  assert.strictEqual(built.onSessionStart, f1, "Function identity must be preserved");
  assert.strictEqual(typeof built.onPreToolUse, "function");
  assert.strictEqual(built.onPreToolUse, f2, "Function identity must be preserved");
  assert.strictEqual(typeof built.onPreMcpToolCall, "function", "onPreMcpToolCall should be accepted as a named hook");

  // should NOT include non-function, undefined, or unknown keys
  assert(!Object.prototype.hasOwnProperty.call(built, "onEvent"), "onEvent must be rejected by buildLoreHooks");
  assert(!Object.prototype.hasOwnProperty.call(built, "unknownHook"), "unknownHook must be rejected");
  assert(!Object.prototype.hasOwnProperty.call(built, "onSessionEnd"), "undefined-valued hooks must be omitted");
  assert(!Object.prototype.hasOwnProperty.call(built, "onUserPromptSubmitted"), "non-function-valued hooks must be omitted");

  console.log("hook-contract programmatic test: OK");
};

await run();
