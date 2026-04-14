/**
 * tests/unit/config.test.mjs
 *
 * Unit tests for lib/config.mjs.
 *
 * Covers:
 *   - loadConfig() throws an actionable error when the config file is malformed JSON.
 *   - The error message includes the resolved config path and the original parse message.
 *
 * Run:
 *   node --test tests/unit/config.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MALFORMED_FIXTURE = resolve(
  __dirname,
  "../fixtures/configs/malformed.json",
);

// Cache-bust counter so each test gets a fresh module evaluation.
let bust = 0;
async function freshConfig(envOverrides = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const url = new URL(`../../lib/config.mjs?v=${++bust}`, import.meta.url);
    return await import(url.href);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

describe("loadConfig", () => {
  test("throws an actionable error for a malformed config file", async () => {
    const mod = await freshConfig({ LORE_CONFIG: MALFORMED_FIXTURE });

    await assert.rejects(
      () => mod.loadConfig(),
      (err) => {
        assert.ok(
          err instanceof Error,
          "error should be an Error instance",
        );
        assert.ok(
          err.message.includes(MALFORMED_FIXTURE),
          `error message should include config path, got: ${err.message}`,
        );
        // The original JSON parse message should be present.
        assert.ok(
          err.message.toLowerCase().includes("json") ||
            err.message.includes("parse") ||
            err.message.includes("Unexpected") ||
            err.message.includes("token") ||
            err.message.includes("end of"),
          `error message should include parse details, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
