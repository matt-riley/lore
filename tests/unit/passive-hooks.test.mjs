/**
 * tests/unit/passive-hooks.test.mjs
 *
 * Unit tests for lib/passive-hooks.mjs.
 *
 * Covers:
 *   - buildErrorTelemetryRecord: null/undefined/malformed payloads return null
 *   - buildErrorTelemetryRecord: valid payloads produce correct category, recoverability, fingerprint
 *   - No raw message/stack fields ever appear in the returned record
 *   - deriveToolCategory: correct category from known tool names
 *   - normalizeToolArgsShape: JSON-string toolArgs safely parsed (structural shape only)
 *   - buildPostToolUseObservation: null/undefined/malformed return null
 *   - buildPostToolUseObservation: valid payloads return categorical fields, no raw args/result
 *   - buildErrorFingerprint: deterministic for same inputs, distinct for different inputs
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  ERROR_CONTEXT_CATEGORY,
  RECOVERABILITY,
  TOOL_CATEGORY,
  buildErrorFingerprint,
  buildErrorTelemetryRecord,
  buildPostToolUseObservation,
  deriveToolCategory,
  normalizeToolArgsShape,
} from "../../lib/passive-hooks.mjs";

// ---------------------------------------------------------------------------
// buildErrorTelemetryRecord — null / undefined / malformed
// ---------------------------------------------------------------------------

describe("buildErrorTelemetryRecord — absent/malformed payloads return null", () => {
  test("returns null for null payload", () => {
    assert.strictEqual(buildErrorTelemetryRecord(null), null);
  });

  test("returns null for undefined payload", () => {
    assert.strictEqual(buildErrorTelemetryRecord(undefined), null);
  });

  test("returns null for primitive string payload", () => {
    assert.strictEqual(buildErrorTelemetryRecord("error string"), null);
  });

  test("returns null for number payload", () => {
    assert.strictEqual(buildErrorTelemetryRecord(42), null);
  });
});

// ---------------------------------------------------------------------------
// buildErrorTelemetryRecord — valid payloads
// ---------------------------------------------------------------------------

describe("buildErrorTelemetryRecord — valid payloads produce correct categorical fields", () => {
  test("empty object produces unknown category and unknown recoverability", () => {
    const record = buildErrorTelemetryRecord({});
    assert.ok(record, "should return a record");
    assert.strictEqual(record.contextCategory, ERROR_CONTEXT_CATEGORY.UNKNOWN);
    assert.strictEqual(record.recoverability, RECOVERABILITY.UNKNOWN);
    assert.ok(typeof record.fingerprint === "string" && record.fingerprint.length === 16);
  });

  test("passes session ID through", () => {
    const record = buildErrorTelemetryRecord({}, "sess-123");
    assert.strictEqual(record.sessionId, "sess-123");
  });

  test("null / empty session ID normalised to null", () => {
    assert.strictEqual(buildErrorTelemetryRecord({}, null)?.sessionId, null);
    assert.strictEqual(buildErrorTelemetryRecord({}, "")?.sessionId, null);
    assert.strictEqual(buildErrorTelemetryRecord({})?.sessionId, null);
  });

  test("timeout error code → timeout category", () => {
    const record = buildErrorTelemetryRecord({ error: { code: "ETIMEDOUT", name: "Error" } });
    assert.strictEqual(record.contextCategory, ERROR_CONTEXT_CATEGORY.TIMEOUT);
  });

  test("EACCES error code → permission category + unrecoverable", () => {
    const record = buildErrorTelemetryRecord({ error: { code: "EACCES", name: "Error" } });
    assert.strictEqual(record.contextCategory, ERROR_CONTEXT_CATEGORY.PERMISSION);
    assert.strictEqual(record.recoverability, RECOVERABILITY.UNRECOVERABLE);
  });

  test("network context hint → network category", () => {
    const record = buildErrorTelemetryRecord({ context: "network fetch failed", error: {} });
    assert.strictEqual(record.contextCategory, ERROR_CONTEXT_CATEGORY.NETWORK);
  });

  test("tool context hint → tool_use category", () => {
    const record = buildErrorTelemetryRecord({ context: "tool execution error", error: {} });
    assert.strictEqual(record.contextCategory, ERROR_CONTEXT_CATEGORY.TOOL_USE);
  });

  test("retryable: true → recoverable", () => {
    const record = buildErrorTelemetryRecord({ retryable: true, error: {} });
    assert.strictEqual(record.recoverability, RECOVERABILITY.RECOVERABLE);
  });

  test("retryable: false → unrecoverable", () => {
    const record = buildErrorTelemetryRecord({ retryable: false, error: {} });
    assert.strictEqual(record.recoverability, RECOVERABILITY.UNRECOVERABLE);
  });

  test("SyntaxError name → parse category", () => {
    const record = buildErrorTelemetryRecord({ error: { name: "SyntaxError" } });
    assert.strictEqual(record.contextCategory, ERROR_CONTEXT_CATEGORY.PARSE);
  });
});

// ---------------------------------------------------------------------------
// buildErrorTelemetryRecord — no raw message/stack persisted
// ---------------------------------------------------------------------------

describe("buildErrorTelemetryRecord — never exposes raw message/stack", () => {
  test("returned record has no message or stack fields", () => {
    const payload = {
      error: {
        message: "Sensitive: /home/user/.ssh/id_rsa not found",
        stack: "Error: Sensitive\n    at doThing (index.js:42:7)\n    at ...",
        name: "Error",
        code: "ENOENT",
      },
      context: "file access",
    };
    const record = buildErrorTelemetryRecord(payload, "sess-1");
    assert.ok(record, "should return a record");
    assert.strictEqual("message" in record, false, "message must not appear in record");
    assert.strictEqual("stack" in record, false, "stack must not appear in record");
    assert.strictEqual("error" in record, false, "raw error object must not appear in record");
    assert.strictEqual("payload" in record, false, "raw payload must not appear in record");

    // Verify the record only has the expected safe keys
    const allowedKeys = new Set(["sessionId", "contextCategory", "recoverability", "fingerprint"]);
    for (const key of Object.keys(record)) {
      assert.ok(allowedKeys.has(key), `unexpected key in record: ${key}`);
    }
  });

  test("fingerprint is non-reversible: same category+recoverability+name produces same hash", () => {
    const fp1 = buildErrorFingerprint("tool_use", "unknown", "TypeError");
    const fp2 = buildErrorFingerprint("tool_use", "unknown", "TypeError");
    assert.strictEqual(fp1, fp2, "same inputs must produce same fingerprint");
    assert.strictEqual(fp1.length, 16, "fingerprint must be 16 hex characters");
    // Confirm it does not contain recognisable raw text
    assert.ok(!fp1.includes("TypeError"), "fingerprint must not contain raw error name");
  });

  test("different categories produce different fingerprints", () => {
    const fp1 = buildErrorFingerprint("tool_use", "unknown", "");
    const fp2 = buildErrorFingerprint("network", "unknown", "");
    assert.notStrictEqual(fp1, fp2, "different categories must produce different fingerprints");
  });
});

// ---------------------------------------------------------------------------
// deriveToolCategory
// ---------------------------------------------------------------------------

describe("deriveToolCategory", () => {
  test("bash → bash", () => assert.strictEqual(deriveToolCategory("bash"), TOOL_CATEGORY.BASH));
  test("run_command → bash", () => assert.strictEqual(deriveToolCategory("run_command"), TOOL_CATEGORY.BASH));
  test("read_file → file", () => assert.strictEqual(deriveToolCategory("read_file"), TOOL_CATEGORY.FILE));
  test("view → file", () => assert.strictEqual(deriveToolCategory("view"), TOOL_CATEGORY.FILE));
  test("grep → search", () => assert.strictEqual(deriveToolCategory("grep"), TOOL_CATEGORY.SEARCH));
  test("glob → search", () => assert.strictEqual(deriveToolCategory("glob"), TOOL_CATEGORY.SEARCH));
  test("web_fetch → network", () => assert.strictEqual(deriveToolCategory("web_fetch"), TOOL_CATEGORY.NETWORK));
  test("lore_recall → memory", () => assert.strictEqual(deriveToolCategory("lore_recall"), TOOL_CATEGORY.MEMORY));
  test("memory_search → memory", () => assert.strictEqual(deriveToolCategory("memory_search"), TOOL_CATEGORY.MEMORY));
  test("unknown_tool → other", () => assert.strictEqual(deriveToolCategory("unknown_tool"), TOOL_CATEGORY.OTHER));
  test("null → other", () => assert.strictEqual(deriveToolCategory(null), TOOL_CATEGORY.OTHER));
  test("undefined → other", () => assert.strictEqual(deriveToolCategory(undefined), TOOL_CATEGORY.OTHER));
  test("empty string → other", () => assert.strictEqual(deriveToolCategory(""), TOOL_CATEGORY.OTHER));
});

// ---------------------------------------------------------------------------
// normalizeToolArgsShape
// ---------------------------------------------------------------------------

describe("normalizeToolArgsShape — structural shape only, never raw args", () => {
  test("null → empty", () => {
    const shape = normalizeToolArgsShape(null);
    assert.deepStrictEqual(shape, { parsed: true, isObject: false, isEmpty: true });
  });

  test("undefined → empty", () => {
    const shape = normalizeToolArgsShape(undefined);
    assert.deepStrictEqual(shape, { parsed: true, isObject: false, isEmpty: true });
  });

  test("plain object → parsed, isObject, not empty", () => {
    const shape = normalizeToolArgsShape({ command: "ls" });
    assert.deepStrictEqual(shape, { parsed: true, isObject: true, isEmpty: false });
  });

  test("empty object → parsed, isObject, empty", () => {
    const shape = normalizeToolArgsShape({});
    assert.deepStrictEqual(shape, { parsed: true, isObject: true, isEmpty: true });
  });

  test("JSON string of object → parsed, isObject, not empty", () => {
    const shape = normalizeToolArgsShape('{"command":"ls"}');
    assert.deepStrictEqual(shape, { parsed: true, isObject: true, isEmpty: false });
  });

  test("JSON string of empty object → parsed, isObject, empty", () => {
    const shape = normalizeToolArgsShape("{}");
    assert.deepStrictEqual(shape, { parsed: true, isObject: true, isEmpty: true });
  });

  test("malformed JSON string → not parsed", () => {
    const shape = normalizeToolArgsShape("{bad json");
    assert.deepStrictEqual(shape, { parsed: false, isObject: false, isEmpty: false });
  });

  test("JSON string of array → parsed, not isObject", () => {
    const shape = normalizeToolArgsShape('["a","b"]');
    assert.deepStrictEqual(shape, { parsed: true, isObject: false, isEmpty: false });
  });
});

// ---------------------------------------------------------------------------
// buildPostToolUseObservation — absent/malformed payloads return null
// ---------------------------------------------------------------------------

describe("buildPostToolUseObservation — absent/malformed payloads return null", () => {
  test("null payload → null", () => assert.strictEqual(buildPostToolUseObservation(null), null));
  test("undefined payload → null", () => assert.strictEqual(buildPostToolUseObservation(undefined), null));
  test("string payload → null", () => assert.strictEqual(buildPostToolUseObservation("bash"), null));
  test("empty object (no toolName) → null", () => assert.strictEqual(buildPostToolUseObservation({}), null));
});

// ---------------------------------------------------------------------------
// buildPostToolUseObservation — valid payloads
// ---------------------------------------------------------------------------

describe("buildPostToolUseObservation — valid payloads produce categorical fields, no raw args/result", () => {
  test("bash tool with success=true", () => {
    const obs = buildPostToolUseObservation({ toolName: "bash", success: true, toolArgs: { command: "ls" } });
    assert.ok(obs, "should return an observation");
    assert.strictEqual(obs.toolName, "bash");
    assert.strictEqual(obs.toolCategory, TOOL_CATEGORY.BASH);
    assert.strictEqual(obs.success, true);
    // argsShape is structural metadata, not raw args content
    assert.deepStrictEqual(obs.argsShape, { parsed: true, isObject: true, isEmpty: false });
    assert.strictEqual("toolResult" in obs, false, "toolResult must not appear in observation");
    assert.strictEqual("args" in obs, false, "raw args must not appear in observation");
  });

  test("success derived from outcome field", () => {
    const obs = buildPostToolUseObservation({ toolName: "grep", outcome: "success" });
    assert.strictEqual(obs.success, true);
  });

  test("failure when success=false", () => {
    const obs = buildPostToolUseObservation({ toolName: "grep", success: false });
    assert.strictEqual(obs.success, false);
  });

  test("JSON-string toolArgs parsed structurally", () => {
    const obs = buildPostToolUseObservation({
      toolName: "bash",
      success: true,
      toolArgs: '{"command":"ls -la"}',
    });
    assert.ok(obs, "should return an observation");
    assert.deepStrictEqual(obs.argsShape, { parsed: true, isObject: true, isEmpty: false });
  });

  test("returned observation has only allowed keys", () => {
    const obs = buildPostToolUseObservation({ toolName: "read_file", success: true });
    const allowedKeys = new Set(["toolName", "toolCategory", "success", "argsShape"]);
    for (const key of Object.keys(obs)) {
      assert.ok(allowedKeys.has(key), `unexpected key in observation: ${key}`);
    }
  });

  test("memory tool category", () => {
    const obs = buildPostToolUseObservation({ toolName: "lore_retain", success: true });
    assert.strictEqual(obs.toolCategory, TOOL_CATEGORY.MEMORY);
  });

  test("toolName truncated to 64 characters", () => {
    const longName = "a".repeat(100);
    const obs = buildPostToolUseObservation({ toolName: longName });
    assert.ok(obs, "should return an observation for long names");
    assert.strictEqual(obs.toolName.length, 64);
  });
});
