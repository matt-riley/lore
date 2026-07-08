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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { createMemoryTools } from "../../lib/memory-tools.mjs";
import {
  buildPortableBundleRequest,
  mapImprovementArtifactRow,
} from "../../lib/memory-tools-portable-bundle.mjs";
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

describe("resolveBundlePath (via buildPortableBundleRequest)", () => {
  test("resolves a relative bundlePath against the Lore package root, not an ancestor of it", () => {
    // The Lore extension is its own git repo, rooted at extensions/lore (one
    // level above lib/, where this module lives). bundlePath is documented
    // as "repository-relative", so a relative path must land inside that
    // repo root -- not several levels above it.
    const repoRoot = path.resolve(new URL("../../", import.meta.url).pathname);
    const request = buildPortableBundleRequest({ bundlePath: "bundle.json" }, { repository: null });
    assert.equal(request.bundlePath, path.join(repoRoot, "bundle.json"));
  });

  test("leaves an absolute bundlePath untouched", () => {
    const absolute = path.join(os.tmpdir(), "somewhere", "bundle.json");
    const request = buildPortableBundleRequest({ bundlePath: absolute }, { repository: null });
    assert.equal(request.bundlePath, absolute);
  });
});

describe("memory_portable_bundle action=import", () => {
  test("imports OKF concepts into semantic memory, retrievable via memory_search", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, tools, cleanup } = await setupFixtureTools({ enabled: true });
    const tmpDir = makeTmpDir();
    try {
      seedApprovedArtifact(db);
      const exportTool = findTool(tools, "memory_portable_bundle");
      const bundleDir = path.join(tmpDir, "okf-bundle");
      await exportTool.handler({ bundlePath: bundleDir, format: "okf" }, { sessionId: "portable-okf-export" });

      const importTool = findTool(tools, "memory_portable_bundle");
      const importOutput = await importTool.handler(
        { action: "import", bundlePath: bundleDir, format: "okf", repository: "fixture-repo" },
        { sessionId: "portable-okf-import" },
      );

      assert.match(importOutput, /action: import/);
      assert.match(importOutput, /importedCount: 1/);
      assert.match(importOutput, /skippedCount: 0/);

      const rows = db.db.prepare("SELECT type, confidence, tags FROM semantic_memory WHERE type = ?").all("okf_concept");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].confidence, 0.7);
      assert.match(rows[0].tags, /okf_import/);

      const search = findTool(tools, "memory_search");
      const searchOutput = await search.handler(
        { query: "retry backoff", type: "okf_concept", limit: 10 },
        { sessionId: "portable-okf-search" },
      );
      assert.match(searchOutput, /Tighten retry backoff/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("re-importing the same bundle reinforces the existing row instead of duplicating it (content is not overwritten by later imports)", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, tools, cleanup } = await setupFixtureTools({ enabled: true });
    const tmpDir = makeTmpDir();
    try {
      seedApprovedArtifact(db);
      const exportTool = findTool(tools, "memory_portable_bundle");
      const bundleDir = path.join(tmpDir, "okf-bundle");
      await exportTool.handler({ bundlePath: bundleDir, format: "okf" }, { sessionId: "portable-okf-export" });

      const importTool = findTool(tools, "memory_portable_bundle");
      await importTool.handler(
        { action: "import", bundlePath: bundleDir, format: "okf", repository: "fixture-repo" },
        { sessionId: "portable-okf-import-1" },
      );
      const [firstRow] = db.db.prepare("SELECT id, content, reinforcement_count FROM semantic_memory WHERE type = ?").all("okf_concept");

      // Edit the exported concept file in place, simulating an updated
      // upstream bundle, then re-import. The upsert path this reuses
      // (shared with assistant_goal/user_identity/recurring_mistake) only
      // bumps confidence/reinforcement_count/tags/metadata on a canonical-key
      // match -- it does not overwrite stored content on later imports. So
      // re-importing an edited concept still lands on the *same* row id
      // (no duplicate) with a higher reinforcement_count, but the original
      // first-imported content is what's retained.
      const conceptFiles = readdirSync(path.join(bundleDir, "artifacts"));
      const conceptPath = path.join(bundleDir, "artifacts", conceptFiles[0]);
      const original = readFileSync(conceptPath, "utf8");
      writeFileSync(conceptPath, original.replaceAll("Reduce retry storms during transient network errors.", "Reduce retry storms -- now with jitter."));

      await importTool.handler(
        { action: "import", bundlePath: bundleDir, format: "okf", repository: "fixture-repo" },
        { sessionId: "portable-okf-import-2" },
      );

      const rows = db.db.prepare("SELECT id, content, reinforcement_count FROM semantic_memory WHERE type = ?").all("okf_concept");
      assert.equal(rows.length, 1, "re-import of an edited concept should reinforce the existing row, not duplicate it");
      assert.equal(rows[0].id, firstRow.id);
      assert.equal(rows[0].content, firstRow.content, "content is not overwritten by later imports (matches existing canonical-key upsert semantics)");
      assert.ok(rows[0].reinforcement_count > firstRow.reinforcement_count);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("throws when bundlePath is missing", { skip: SKIP_NO_FTS5 }, async () => {
    const { tools, cleanup } = await setupFixtureTools({ enabled: true });
    try {
      const importTool = findTool(tools, "memory_portable_bundle");
      await assert.rejects(
        importTool.handler({ action: "import", format: "okf" }, { sessionId: "portable-okf-missing-path" }),
        /bundlePath/,
      );
    } finally {
      cleanup();
    }
  });

  test("throws when bundlePath is a file, not a directory", { skip: SKIP_NO_FTS5 }, async () => {
    const { tools, cleanup } = await setupFixtureTools({ enabled: true });
    const tmpDir = makeTmpDir();
    try {
      const filePath = path.join(tmpDir, "not-a-dir.md");
      writeFileSync(filePath, "not a bundle directory");
      const importTool = findTool(tools, "memory_portable_bundle");
      await assert.rejects(
        importTool.handler({ action: "import", bundlePath: filePath, format: "okf" }, { sessionId: "portable-okf-file-path" }),
        /is not a directory/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("succeeds as a no-op for an empty bundle directory", { skip: SKIP_NO_FTS5 }, async () => {
    const { tools, cleanup } = await setupFixtureTools({ enabled: true });
    const tmpDir = makeTmpDir();
    try {
      const emptyBundleDir = path.join(tmpDir, "empty-bundle");
      mkdirSync(emptyBundleDir, { recursive: true });
      const importTool = findTool(tools, "memory_portable_bundle");
      const output = await importTool.handler(
        { action: "import", bundlePath: emptyBundleDir, format: "okf" },
        { sessionId: "portable-okf-empty" },
      );
      assert.match(output, /conceptsFound: 0/);
      assert.match(output, /importedCount: 0/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("throws when format=json is combined with action=import", { skip: SKIP_NO_FTS5 }, async () => {
    const { tools, cleanup } = await setupFixtureTools({ enabled: true });
    const tmpDir = makeTmpDir();
    try {
      const importTool = findTool(tools, "memory_portable_bundle");
      await assert.rejects(
        importTool.handler(
          { action: "import", bundlePath: tmpDir, format: "json" },
          { sessionId: "portable-json-import-unsupported" },
        ),
        /format=okf only/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      cleanup();
    }
  });

  test("caps imported concepts at the requested limit", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, tools, cleanup } = await setupFixtureTools({ enabled: true });
    const tmpDir = makeTmpDir();
    try {
      const bundleDir = path.join(tmpDir, "many-concepts-bundle");
      mkdirSync(path.join(bundleDir, "artifacts"), { recursive: true });
      for (let i = 0; i < 5; i += 1) {
        writeFileSync(
          path.join(bundleDir, "artifacts", `concept-${i}.md`),
          `---\ntype: "Concept"\ntitle: "Concept ${i}"\n---\n\nBody for concept ${i}.\n`,
        );
      }

      const importTool = findTool(tools, "memory_portable_bundle");
      const output = await importTool.handler(
        { action: "import", bundlePath: bundleDir, format: "okf", limit: 2 },
        { sessionId: "portable-okf-limit" },
      );

      assert.match(output, /conceptsFound: 5/);
      assert.match(output, /importedCount: 2/);
      const rows = db.db.prepare("SELECT id FROM semantic_memory WHERE type = ?").all("okf_concept");
      assert.equal(rows.length, 2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      cleanup();
    }
  });
});
