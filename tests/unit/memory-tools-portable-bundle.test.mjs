/**
 * tests/unit/memory-tools-portable-bundle.test.mjs
 *
 * Unit/integration tests for the memory_portable_bundle tool handler
 * (lib/memory-tools-builders.mjs) and its row-mapping helper
 * (lib/memory-tools-portable-bundle.mjs).
 *
 * Covers:
 *   - mapImprovementArtifactRow: converts a raw snake_case DB row into the
 *     camelCase portable-bundle artifact shape (sourceCaseId, reviewState,
 *     nested proposal object, createdAt/updatedAt).
 *   - memory_portable_bundle tool handler, format=json: end-to-end against
 *     a real fixture DB, asserting the exported artifact shape.
 *   - memory_portable_bundle tool handler, format=okf: end-to-end against
 *     a real fixture DB, asserting the generated concept frontmatter
 *     (reviewState, timestamp, resource, tags) is populated from the raw DB
 *     row via the same mapping used for format=json -- this is a regression
 *     test for a review finding where the okf branch passed raw DB rows
 *     directly into buildOkfBundleDocuments, which expects the mapped
 *     camelCase shape.
 *
 * Run:
 *   node --test tests/unit/memory-tools-portable-bundle.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { createMemoryTools } from "../../lib/memory-tools.mjs";
import { mapImprovementArtifactRow } from "../../lib/memory-tools-portable-bundle.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";
import { findTool } from "../helpers/tool-helpers.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function makeTmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-portable-bundle-test-"));
}

function buildRuntime(db, config, overrides = {}) {
  return {
    initialized: true,
    lastError: null,
    db,
    config,
    repository: "fixture-repo",
    ...overrides,
  };
}

async function setupFixtureTools(configOverrides = {}, runtimeOverrides = {}) {
  const fixture = await withFixtureDb({ configOverrides });
  return {
    ...fixture,
    tools: createMemoryTools({
      getRuntime: async () => buildRuntime(fixture.db, fixture.config, runtimeOverrides),
    }),
  };
}

/** Inserts an approved, proposal-backed improvement artifact so it is picked up by listImprovementArtifacts({reviewState: "approved", hasProposal: true}). */
function seedApprovedArtifact(db) {
  const id = db.upsertImprovementArtifact({
    sourceCaseId: "case-portable-1",
    sourceKind: "session_review",
    title: "Tighten retry backoff",
    summary: "Reduce retry storms during transient network errors.",
    evidence: { occurrences: 3 },
  });
  db.setImprovementArtifactProposal({
    id,
    proposalType: "diff",
    proposalPath: "docs/proposals/retry.md",
    proposalHash: "abc123",
    reviewState: "approved",
  });
  return id;
}

describe("mapImprovementArtifactRow", () => {
  test("converts a raw snake_case DB row into the camelCase portable-bundle shape", () => {
    const row = {
      id: "artifact-1",
      source_case_id: "case-1",
      source_kind: "session_review",
      title: "Tighten retry backoff",
      summary: "Reduce retry storms.",
      status: "active",
      review_state: "approved",
      proposal_type: "diff",
      proposal_path: "docs/proposals/retry.md",
      proposal_hash: "abc123",
      evidence: { occurrences: 3 },
      trace: { signal: "router" },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    };
    assert.deepEqual(mapImprovementArtifactRow(row), {
      id: "artifact-1",
      sourceCaseId: "case-1",
      sourceKind: "session_review",
      title: "Tighten retry backoff",
      summary: "Reduce retry storms.",
      status: "active",
      reviewState: "approved",
      proposal: { type: "diff", path: "docs/proposals/retry.md", hash: "abc123" },
      evidence: { occurrences: 3 },
      trace: { signal: "router" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  test("defaults reviewState to 'none' and proposal fields to null when absent", () => {
    const mapped = mapImprovementArtifactRow({ id: "artifact-2", title: "No proposal yet" });
    assert.equal(mapped.reviewState, "none");
    assert.deepEqual(mapped.proposal, { type: null, path: null, hash: null });
    assert.deepEqual(mapped.evidence, {});
    assert.deepEqual(mapped.trace, {});
  });
});

describe("memory_portable_bundle tool handler", () => {
  test("format=json exports approved artifacts using the mapped camelCase shape", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, tools, cleanup } = await setupFixtureTools({ enabled: true });
    const tmpDir = makeTmpDir();
    try {
      seedApprovedArtifact(db);
      const tool = findTool(tools, "memory_portable_bundle");
      const bundlePath = path.join(tmpDir, "bundle.json");
      const output = await tool.handler({ bundlePath, format: "json" }, { sessionId: "portable-json" });

      assert.match(output, /exportedImprovementCount: 1/);
      const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
      const [artifact] = bundle.data.improvementArtifacts;
      assert.equal(artifact.reviewState, "approved");
      assert.equal(artifact.sourceCaseId, "case-portable-1");
      assert.equal(artifact.proposal.path, "docs/proposals/retry.md");
      assert.ok(artifact.updatedAt || artifact.createdAt);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("format=okf exports approved artifacts with reviewState/timestamp/resource/tags populated from DB rows", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, tools, cleanup } = await setupFixtureTools({ enabled: true });
    const tmpDir = makeTmpDir();
    try {
      seedApprovedArtifact(db);
      const tool = findTool(tools, "memory_portable_bundle");
      const bundleDir = path.join(tmpDir, "okf-bundle");
      const output = await tool.handler({ bundlePath: bundleDir, format: "okf" }, { sessionId: "portable-okf" });

      assert.match(output, /format: okf/);
      assert.match(output, /exportedImprovementCount: 1/);

      const conceptFiles = readdirSync(path.join(bundleDir, "artifacts"));
      assert.equal(conceptFiles.length, 1, "expected exactly one exported concept file");
      const contents = readFileSync(path.join(bundleDir, "artifacts", conceptFiles[0]), "utf8");

      // Regression coverage: these fields all come from a raw DB row
      // (source_case_id, review_state, updated_at, proposal_path) and were
      // previously dropped/undefined because the okf branch skipped the
      // row -> camelCase mapping step that format=json uses.
      assert.match(contents, /reviewState: "approved"/);
      assert.match(contents, /sourceCaseId: "case-portable-1"/);
      assert.match(contents, /resource: "docs\/proposals\/retry\.md"/);
      assert.match(contents, /tags:\s*\[[^\]]*"approved"[^\]]*\]/);
      assert.match(contents, /timestamp: "\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      cleanup();
    }
  });
});
