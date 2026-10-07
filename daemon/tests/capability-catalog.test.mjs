// Golden checks for the checked-in v2 capability catalog.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  LORE_CAPABILITY_SPECS,
  resolveLoreToolName,
} from "../../lib/capabilities/capability-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const catalog = JSON.parse(
  readFileSync(path.join(ROOT, "daemon", "clients", "capability-catalog.json"), "utf8"),
);

test("catalog covers every canonical v1 operation exactly once", () => {
  const expected = LORE_CAPABILITY_SPECS.map((spec) => spec.name).sort();
  const actual = catalog.rows.map((row) => row.name).sort();
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
});

test("aliases are unique across the namespace and resolve canonically", () => {
  const seen = new Map();
  for (const row of catalog.rows) {
    for (const alias of [row.name, ...row.aliases]) {
      assert.ok(!seen.has(alias), `alias ${alias} is ambiguous`);
      seen.set(alias, row.name);
    }
  }
  assert.equal(seen.get("lore_save"), "lore_retain");
  assert.equal(seen.get("memory_save"), "lore_retain");
  assert.equal(seen.get("memory_search"), "lore_search");
  for (const row of catalog.rows) {
    assert.equal(resolveLoreToolName(row.name), row.name);
  }
});

test("every row declares support, mutability and an implemented route", () => {
  for (const row of catalog.rows) {
    assert.ok(["implemented", "planned"].includes(row.support), row.name);
    assert.ok(["read", "write"].includes(row.mutability), row.name);
    if (row.support === "implemented") {
      assert.match(row.route, /^(?:\/v2\/|local:)/, row.name);
    } else {
      assert.equal(row.route, null, row.name);
    }
  }
  const implemented = catalog.rows.filter((row) => row.support === "implemented");
  assert.deepEqual(
    implemented.map((row) => row.name).sort(),
    [
      "lore_audit_extractions",
      "lore_doctor",
      "lore_explain",
      "lore_forget",
      "lore_recall",
      "lore_retain",
      "lore_search",
      "lore_status",
      "lore_validate",
      "memory_capability_inventory",
    ],
  );
});

test("daemon capabilities are unique and namespaced", () => {
  assert.equal(new Set(catalog.daemonCapabilities).size, catalog.daemonCapabilities.length);
  for (const capability of catalog.daemonCapabilities) {
    assert.match(capability, /^[a-z]+(\.[a-z]+)+$/);
  }
});
