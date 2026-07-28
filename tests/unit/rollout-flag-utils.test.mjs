/**
 * tests/unit/rollout-flag-utils.test.mjs
 *
 * Unit tests for lib/rollout-flag-utils.mjs.
 *
 * Covers:
 *   - readRolloutBoolean reads the key from config.rollout with the given fallback.
 *   - createRolloutBooleanReader factory returns a reader that gates on its own key.
 *   - Parent-reader gating: when a parentReader returns false the child reader
 *     returns false even when the child flag is explicitly true.
 *   - Null/undefined config handling: no crash, sensible fallback.
 *
 * Run:
 *   node --test tests/unit/rollout-flag-utils.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  readRolloutBoolean,
  createRolloutBooleanReader,
} from "../../lib/rollout-flag-utils.mjs";

describe("readRolloutBoolean", () => {
  test("returns true when key is true", () => {
    assert.equal(readRolloutBoolean({ rollout: { myFlag: true } }, "myFlag", false), true);
  });

  test("returns false when key is false", () => {
    assert.equal(readRolloutBoolean({ rollout: { myFlag: false } }, "myFlag", true), false);
  });

  test("returns fallback when key is absent", () => {
    assert.equal(readRolloutBoolean({ rollout: {} }, "myFlag", true), true);
    assert.equal(readRolloutBoolean({ rollout: {} }, "myFlag", false), false);
  });

  test("returns fallback when rollout is absent", () => {
    assert.equal(readRolloutBoolean({}, "myFlag", true), true);
  });

  test("returns fallback when config is null", () => {
    assert.equal(readRolloutBoolean(null, "myFlag", true), true);
  });

  test("returns fallback when config is undefined", () => {
    assert.equal(readRolloutBoolean(undefined, "myFlag", false), false);
  });
});

describe("createRolloutBooleanReader", () => {
  test("returns true when flag is true and no parent", () => {
    const reader = createRolloutBooleanReader("featureA", false);
    assert.equal(reader({ rollout: { featureA: true } }), true);
  });

  test("returns false when flag is false and no parent", () => {
    const reader = createRolloutBooleanReader("featureA", true);
    assert.equal(reader({ rollout: { featureA: false } }), false);
  });

  test("returns fallback when key is absent and no parent", () => {
    const trueReader = createRolloutBooleanReader("featureA", true);
    const falseReader = createRolloutBooleanReader("featureA", false);
    assert.equal(trueReader({ rollout: {} }), true);
    assert.equal(falseReader({ rollout: {} }), false);
  });

  test("returns false when config is null and no parent", () => {
    const reader = createRolloutBooleanReader("featureA", false);
    assert.equal(reader(null), false);
  });

  describe("parent-reader gating", () => {
    test("returns child value when parent returns true", () => {
      const parent = createRolloutBooleanReader("parentFlag", false);
      const child = createRolloutBooleanReader("childFlag", false, parent);
      const config = { rollout: { parentFlag: true, childFlag: true } };
      assert.equal(child(config), true);
    });

    test("returns false when parent returns false, even if child flag is true", () => {
      const parent = createRolloutBooleanReader("parentFlag", true);
      const child = createRolloutBooleanReader("childFlag", false, parent);
      const config = { rollout: { parentFlag: false, childFlag: true } };
      assert.equal(child(config), false);
    });

    test("returns false when both parent and child flags are false", () => {
      const parent = createRolloutBooleanReader("parentFlag", true);
      const child = createRolloutBooleanReader("childFlag", true, parent);
      const config = { rollout: { parentFlag: false, childFlag: false } };
      assert.equal(child(config), false);
    });

    test("returns false when parent is false and child is absent (fallback true)", () => {
      const parent = createRolloutBooleanReader("parentFlag", true);
      const child = createRolloutBooleanReader("childFlag", true, parent);
      const config = { rollout: { parentFlag: false } };
      assert.equal(child(config), false);
    });

    test("chains three levels: grandparent gates grandchild", () => {
      const grandparent = createRolloutBooleanReader("gpFlag", false);
      const parent = createRolloutBooleanReader("pFlag", false, grandparent);
      const child = createRolloutBooleanReader("cFlag", false, parent);
      const allOn = { rollout: { gpFlag: true, pFlag: true, cFlag: true } };
      assert.equal(child(allOn), true);
      const gpOff = { rollout: { gpFlag: false, pFlag: true, cFlag: true } };
      assert.equal(child(gpOff), false);
    });
  });
});
