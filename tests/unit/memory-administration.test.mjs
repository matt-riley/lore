import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { withFixtureDb } from "../helpers/fixture-db.mjs";
import {
  previewMemoryAdministration,
  applyMemoryAdministration,
  normalizeAdministrationRequest,
} from "../../lib/memory/memory-administration.mjs";

test("administration previews are bounded and fingerprinted without changing rows", async () => {
  const { db, config, cleanup } = await withFixtureDb();
  try {
    const id = db.insertSemanticMemory({
      type: "user_preference",
      content: "Prefer the green path.",
      scope: "repo",
      repository: "fixture/repo",
    });
    const before = readFileSync(config.paths.derivedStorePath);
    const plan = previewMemoryAdministration(db, normalizeAdministrationRequest({
      operation: "purge",
      memoryIds: [id],
    }));
    assert.equal(plan.action, "preview");
    assert.equal(plan.operation, "purge");
    assert.deepEqual(plan.affected.memoryIds, [id]);
    assert.match(plan.planFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(readFileSync(config.paths.derivedStorePath), before);
    assert.equal(plan.backup.created, false);
  } finally {
    cleanup();
  }
});

test("correction apply requires the preview fingerprint and preserves manual authority", async () => {
  const { db, cleanup } = await withFixtureDb();
  try {
    const id = db.insertSemanticMemory({
      type: "user_preference",
      content: "Prefer the old path.",
      scope: "repo",
      repository: "fixture/repo",
    });
    const request = normalizeAdministrationRequest({
      operation: "correct",
      memoryId: id,
      content: "Prefer the new path.",
      reason: "User correction",
    });
    const plan = previewMemoryAdministration(db, request);
    assert.throws(() => applyMemoryAdministration(db, request, "stale"), /fingerprint/i);
    const result = applyMemoryAdministration(db, request, plan.planFingerprint);
    assert.equal(result.integrity, "ok");
    const rows = db.db.prepare("SELECT id, content, superseded_by, scope_source FROM semantic_memory ORDER BY created_at").all();
    assert.equal(rows.find((row) => row.id === id).superseded_by, result.replacementId);
    const replacement = rows.find((row) => row.id === result.replacementId);
    assert.equal(replacement.content, "Prefer the new path.");
    assert.equal(replacement.scope_source, "manual");
  } finally {
    cleanup();
  }
});

test("purge rejects unbounded and implicit global selection", () => {
  assert.throws(() => normalizeAdministrationRequest({ operation: "purge" }), /explicit selector/i);
  assert.throws(() => normalizeAdministrationRequest({ operation: "purge", memoryIds: Array.from({ length: 201 }, (_, i) => String(i)) }), /200/);
  assert.throws(() => normalizeAdministrationRequest({ operation: "purge", repository: "global" }), /scope.*global/i);
});

test("global purge is a distinct explicit selector", async () => {
  const { db, cleanup } = await withFixtureDb();
  try {
    const globalId = db.insertSemanticMemory({ type: "user_preference", content: "Global fixture preference.", scope: "global" });
    const repoId = db.insertSemanticMemory({ type: "user_preference", content: "Repo fixture preference.", scope: "repo", repository: "fixture/repo" });
    const plan = previewMemoryAdministration(db, normalizeAdministrationRequest({ operation: "purge", scope: "global" }));
    assert.deepEqual(plan.affected.memoryIds, [globalId]);
    const result = applyMemoryAdministration(db, normalizeAdministrationRequest({ operation: "purge", scope: "global" }), plan.planFingerprint);
    assert.equal(result.integrity, "ok");
    assert.equal(db.db.prepare("SELECT 1 FROM semantic_memory WHERE id = ?").get(globalId), undefined);
    assert.ok(db.db.prepare("SELECT 1 FROM semantic_memory WHERE id = ?").get(repoId));
  } finally {
    cleanup();
  }
});

test("correction repository selects the replacement destination", async () => {
  const { db, cleanup } = await withFixtureDb();
  try {
    const id = db.insertSemanticMemory({ type: "user_preference", content: "Other repository.", scope: "repo", repository: "fixture/other" });
    const plan = previewMemoryAdministration(db, normalizeAdministrationRequest({ operation: "correct", memoryId: id, repository: "fixture/repo", content: "Wrong target" }));
    assert.equal(plan.replacement.repository, "fixture/repo");
    const result = applyMemoryAdministration(db, { operation: "correct", memoryId: id, repository: "fixture/repo", content: "Wrong target" }, plan.planFingerprint);
    assert.equal(result.replacement.repository, "fixture/repo");
  } finally {
    cleanup();
  }
});

test("operation-specific selectors cannot enter another mutation path", () => {
  assert.throws(() => normalizeAdministrationRequest({ operation: "purge", repositoryMappings: [{ legacy: "a", canonical: "b" }] }), /only supported by repair/);
  assert.throws(() => normalizeAdministrationRequest({ operation: "correct", memoryId: "one", type: "" }), /non-empty/);
  assert.throws(() => normalizeAdministrationRequest({ operation: "purge", memoryIds: ["one"], includeDependentAggregates: "true" }), /boolean/);
});
