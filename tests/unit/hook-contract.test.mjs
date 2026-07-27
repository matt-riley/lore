import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildLoreHooks } from "../../lib/hook-registration.mjs";

// Verified SDK hook contract (seven-hook superset used for validation)
const VERIFIED_HOOKS = [
  "onPreToolUse",
  "onPostToolUse",
  "onUserPromptSubmitted",
  "onSessionStart",
  "onSessionEnd",
  "onErrorOccurred",
  "onEvent",
];

describe("hook-registration helper", () => {
  test("returns only defined handlers and preserves function identity", () => {
    const sentinelA = () => "a";
    const sentinelB = function foo() { return "b"; };
    const sentinelC = () => "c";

    const handlers = {
      onSessionStart: sentinelA,
      onUserPromptSubmitted: sentinelB,
      onFooBar: sentinelC, // not a known/allowed hook
      onEvent: undefined, // explicitly undefined should be omitted
    };

    const built = buildLoreHooks(handlers);

    // keys should be a subset of VERIFIED_HOOKS
    const keys = Object.keys(built);
    for (const k of keys) {
      assert.ok(VERIFIED_HOOKS.includes(k), `unexpected hook key: ${k}`);
    }

    // expected keys present
    assert.strictEqual(built.onSessionStart, sentinelA);
    assert.strictEqual(built.onUserPromptSubmitted, sentinelB);

    // unexpected keys omitted
    assert.equal(built.onFooBar, undefined);

    // explicitly undefined omitted
    assert.equal(built.onEvent, undefined);
  });
});
