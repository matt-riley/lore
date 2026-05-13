import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalizeText } from "../../lib/text-normalizer.mjs";

describe("normalizeText", () => {
  test("collapses internal whitespace and trims ends", () => {
    assert.equal(normalizeText("  hello\tworld\nfrom lore  "), "hello world from lore");
  });

  test("returns an empty string for nullish input", () => {
    assert.equal(normalizeText(null), "");
    assert.equal(normalizeText(undefined), "");
  });
});
