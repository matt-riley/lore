/**
 * tests/unit/okf-bundle-import.test.mjs
 *
 * Unit tests for lib/okf-bundle-import.mjs (pure OKF concept -> semantic
 * memory mapping) and the okf_concept canonical key added to
 * lib/memory-scope.mjs's buildSemanticCanonicalKey().
 *
 * Covers:
 *   - buildOkfImportMemories: maps concept fields (title/description/body,
 *     type/tags) into a semantic-memory-shaped object, defaults confidence
 *     to 0.7, is overridable, and always tags/types imported rows distinctly
 *     from self-authored memory (memory_save).
 *   - okfConceptKey canonical key: same repository+conceptId produces a
 *     stable canonical key across two calls even when the concept's body
 *     text differs -- this is what lets action=import upsert/reinforce an
 *     edited concept instead of duplicating it on re-import.
 *   - formatOkfImportResult: output shape/notes.
 *
 * Run:
 *   node --test tests/unit/okf-bundle-import.test.mjs
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildOkfImportMemories, formatOkfImportResult } from "../../lib/okf-bundle-import.mjs";
import { buildSemanticCanonicalKey } from "../../lib/memory-scope.mjs";

function makeConcept(overrides = {}) {
  return {
    id: "artifacts/retry-backoff",
    relativePath: "artifacts/retry-backoff.md",
    type: "Improvement Artifact",
    title: "Tighten retry backoff",
    description: "Reduce retry storms during transient network errors.",
    resource: "docs/proposals/retry.md",
    tags: ["session_review", "approved"],
    timestamp: "2026-01-02T00:00:00.000Z",
    frontmatter: {},
    body: "# Tighten retry backoff\n\nReduce retry storms during transient network errors.",
    ...overrides,
  };
}

describe("buildOkfImportMemories", () => {
  test("maps a concept into a semantic-memory-shaped object with defaults", () => {
    const [memory] = buildOkfImportMemories({ concepts: [makeConcept()], repository: "fixture-repo" });

    assert.equal(memory.type, "okf_concept");
    assert.equal(memory.repository, "fixture-repo");
    assert.equal(memory.confidence, 0.7);
    assert.match(memory.content, /Tighten retry backoff/);
    assert.match(memory.content, /Reduce retry storms/);
    assert.deepEqual(memory.tags, ["Improvement Artifact", "okf_import", "session_review", "approved"]);
    assert.equal(memory.metadata.source, "memory_okf_import");
    assert.equal(memory.metadata.okfId, "artifacts/retry-backoff");
    assert.equal(memory.metadata.okfConceptKey, "fixture-repo::artifacts/retry-backoff");
    assert.equal(memory.metadata.resource, "docs/proposals/retry.md");
    assert.equal(memory.metadata.timestamp, "2026-01-02T00:00:00.000Z");
  });

  test("uses 'global' in the canonical key when no repository is given", () => {
    const [memory] = buildOkfImportMemories({ concepts: [makeConcept()] });
    assert.equal(memory.repository, null);
    assert.equal(memory.metadata.okfConceptKey, "global::artifacts/retry-backoff");
  });

  test("confidence is overridable", () => {
    const [memory] = buildOkfImportMemories({ concepts: [makeConcept()], confidence: 0.4 });
    assert.equal(memory.confidence, 0.4);
  });

  test("deduplicates tags and tolerates a concept with no tags", () => {
    const [memory] = buildOkfImportMemories({
      concepts: [makeConcept({ type: "Concept", tags: ["Concept", "okf_import"] })],
    });
    assert.deepEqual(memory.tags, ["Concept", "okf_import"]);
  });

  test("returns an empty array for an empty concept list", () => {
    assert.deepEqual(buildOkfImportMemories({ concepts: [] }), []);
    assert.deepEqual(buildOkfImportMemories({}), []);
  });
});

describe("okf_concept canonical key (memory-scope.mjs)", () => {
  test("is stable for the same repository+conceptId even when content differs", () => {
    const keyA = buildSemanticCanonicalKey({
      type: "okf_concept",
      content: "original body text",
      metadata: { okfConceptKey: "fixture-repo::artifacts/retry-backoff" },
    });
    const keyB = buildSemanticCanonicalKey({
      type: "okf_concept",
      content: "edited body text, totally different",
      metadata: { okfConceptKey: "fixture-repo::artifacts/retry-backoff" },
    });
    assert.equal(keyA, keyB);
    assert.equal(keyA, "okf_concept:fixture-repo artifacts retry-backoff");
  });

  test("differs across distinct concept ids", () => {
    const keyA = buildSemanticCanonicalKey({
      type: "okf_concept",
      content: "x",
      metadata: { okfConceptKey: "fixture-repo::artifacts/a" },
    });
    const keyB = buildSemanticCanonicalKey({
      type: "okf_concept",
      content: "x",
      metadata: { okfConceptKey: "fixture-repo::artifacts/b" },
    });
    assert.notEqual(keyA, keyB);
  });

  test("returns null when okfConceptKey metadata is missing", () => {
    assert.equal(buildSemanticCanonicalKey({ type: "okf_concept", content: "x", metadata: {} }), null);
  });
});

describe("formatOkfImportResult", () => {
  test("reports action, format, counts, and rollback guidance", () => {
    const output = formatOkfImportResult({
      bundleDir: "tmp/okf-bundle",
      repository: "fixture-repo",
      importedCount: 2,
      skippedCount: 1,
      totalConceptCount: 3,
    });
    assert.match(output, /action: import/);
    assert.match(output, /format: okf/);
    assert.match(output, /bundlePath: tmp\/okf-bundle/);
    assert.match(output, /repository: fixture-repo/);
    assert.match(output, /conceptsFound: 3/);
    assert.match(output, /importedCount: 2/);
    assert.match(output, /skippedCount: 1/);
    assert.match(output, /memory_search\(type="okf_concept"\)/);
    assert.match(output, /memory_forget/);
  });

  test("defaults repository to 'global' when omitted", () => {
    const output = formatOkfImportResult({ bundleDir: "tmp/x" });
    assert.match(output, /repository: global/);
  });
});
