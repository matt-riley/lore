import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as fixtureDb from "../helpers/fixture-db.mjs";
import * as fixtureConfig from "../helpers/fixture-config.mjs";
import * as tempHome from "../helpers/temp-home.mjs";

describe("fixture-db helpers", () => {
  test("exports the documented fixture helpers", () => {
    assert.strictEqual(typeof fixtureDb.freshDb, "function");
    assert.strictEqual(typeof fixtureDb.seededDb, "function");
    assert.strictEqual(typeof fixtureDb.withFixtureDb, "function");
    assert.ok(Array.isArray(fixtureDb.SEED_MEMORIES));
    assert.strictEqual(typeof fixtureDb.FTS5_AVAILABLE, "boolean");
  });
});

describe("fixture-config helpers", () => {
  test("exports the documented config builders", () => {
    assert.strictEqual(typeof fixtureConfig.buildFixtureConfig, "function");
    assert.strictEqual(typeof fixtureConfig.freshInstallConfig, "function");
    assert.strictEqual(typeof fixtureConfig.enabledConfig, "function");
  });
});

describe("temp-home helpers", () => {
  test("exports the documented temp-home helpers", () => {
    assert.strictEqual(typeof tempHome.buildHomePaths, "function");
    assert.strictEqual(typeof tempHome.createTempHome, "function");
  });
});
