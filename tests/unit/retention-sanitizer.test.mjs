import assert from "node:assert/strict";
import { test } from "node:test";

import { stripInjectedContext } from "../../lib/memory/retention-sanitizer.mjs";

test("strips all Lore-generated context sections before retention", () => {
  const text = [
    "Please fix the parser.",
    "",
    "## Standing Directives",
    "",
    "- An old task rule.",
    "",
    "## Response Style And Addressing",
    "",
    "- An injected style preference.",
  ].join("\n");

  assert.equal(stripInjectedContext(text), "Please fix the parser.");
});

test("leaves ordinary user text untouched", () => {
  const text = "Please fix the parser without changing the public API.";
  assert.equal(stripInjectedContext(text), text);
});
