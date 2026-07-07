/**
 * tests/unit/memory-tools-okf-bundle.test.mjs
 *
 * Unit tests for lib/memory-tools-okf-bundle.mjs.
 *
 * Covers:
 *   - buildOkfBundleDocuments: OKF v0.1 conformance (parseable frontmatter,
 *     non-empty `type` on every concept file, no frontmatter on nested
 *     index files besides the bundle-root one), slug collision handling,
 *     and empty-artifact-list behavior.
 *   - writeOkfBundle: writes the generated documents to disk under the
 *     requested directory, creating subdirectories as needed.
 *   - formatOkfBundleResult: human-readable export report shape.
 *
 * Run:
 *   node --test tests/unit/memory-tools-okf-bundle.test.mjs
 */

import { it, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildOkfBundleDocuments,
  writeOkfBundle,
  formatOkfBundleResult,
} from "../../lib/memory-tools-okf-bundle.mjs";

function makeTmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-okf-bundle-test-"));
}

function sampleArtifacts() {
  return [
    {
      id: "artifact-1",
      sourceCaseId: "case-1",
      sourceKind: "session_review",
      title: "Tighten retry backoff",
      summary: "Reduce retry storms during transient network errors.",
      status: "approved",
      reviewState: "approved",
      proposal: { type: "diff", path: "docs/proposals/retry.md", hash: "abc123" },
      evidence: { occurrences: 3 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "artifact-2",
      sourceCaseId: "case-2",
      sourceKind: "replay_signal",
      title: "Improve day-summary fallback",
      summary: undefined,
      status: "approved",
      reviewState: "approved",
      proposal: {},
      evidence: {},
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: undefined,
    },
  ];
}

describe("buildOkfBundleDocuments", () => {
  it("produces a bundle-root index.md with only okf_version frontmatter", () => {
    const documents = buildOkfBundleDocuments({
      repository: "acme/widgets",
      improvementArtifacts: sampleArtifacts(),
      exportedAt: "2026-01-05T00:00:00.000Z",
    });
    const index = documents.find((doc) => doc.relativePath === "index.md");
    assert.ok(index, "expected an index.md document");
    assert.match(index.contents, /^---\nokf_version: "0\.1"\n---\n/u);
    assert.match(index.contents, /acme\/widgets/u);
  });

  it("emits one concept file per artifact with a non-empty required `type` field", () => {
    const artifacts = sampleArtifacts();
    const documents = buildOkfBundleDocuments({ improvementArtifacts: artifacts });
    const concepts = documents.filter((doc) => doc.relativePath !== "index.md");
    assert.strictEqual(concepts.length, artifacts.length);
    for (const concept of concepts) {
      assert.match(concept.relativePath, /^artifacts\/.+\.md$/u);
      const frontmatterMatch = concept.contents.match(/^---\n([\s\S]*?)\n---/u);
      assert.ok(frontmatterMatch, `missing frontmatter block in ${concept.relativePath}`);
      assert.match(frontmatterMatch[1], /type: "Improvement Artifact"/u);
    }
  });

  it("links every concept from the index body", () => {
    const documents = buildOkfBundleDocuments({ improvementArtifacts: sampleArtifacts() });
    const index = documents.find((doc) => doc.relativePath === "index.md");
    const concepts = documents.filter((doc) => doc.relativePath !== "index.md");
    for (const concept of concepts) {
      assert.ok(
        index.contents.includes(`(${concept.relativePath})`),
        `index.md should link to ${concept.relativePath}`,
      );
    }
  });

  it("de-duplicates slugs derived from colliding artifact ids", () => {
    const artifacts = [
      { id: "Same ID!", title: "First" },
      { id: "same id", title: "Second" },
    ];
    const documents = buildOkfBundleDocuments({ improvementArtifacts: artifacts });
    const paths = documents.filter((doc) => doc.relativePath !== "index.md").map((doc) => doc.relativePath);
    assert.strictEqual(new Set(paths).size, paths.length, "expected unique concept paths");
  });

  it("handles an empty artifact list gracefully", () => {
    const documents = buildOkfBundleDocuments({ improvementArtifacts: [] });
    assert.strictEqual(documents.length, 1);
    assert.match(documents[0].contents, /No approved improvement artifacts to export/u);
  });

  it("preserves proposal and evidence details in the concept body", () => {
    const documents = buildOkfBundleDocuments({ improvementArtifacts: sampleArtifacts() });
    const first = documents.find((doc) => doc.relativePath === "artifacts/artifact-1.md");
    assert.ok(first, "expected artifacts/artifact-1.md to exist");
    assert.match(first.contents, /# Proposal/u);
    assert.match(first.contents, /docs\/proposals\/retry\.md/u);
    assert.match(first.contents, /# Evidence/u);
    assert.match(first.contents, /"occurrences": 3/u);
  });
});

describe("writeOkfBundle", () => {
  it("writes generated documents to disk, creating subdirectories as needed", async () => {
    const tmpDir = makeTmpDir();
    try {
      const bundleDir = path.join(tmpDir, "bundle");
      const documents = buildOkfBundleDocuments({ improvementArtifacts: sampleArtifacts() });
      await writeOkfBundle(bundleDir, documents);

      assert.ok(existsSync(path.join(bundleDir, "index.md")));
      for (const doc of documents) {
        const fullPath = path.join(bundleDir, doc.relativePath);
        assert.ok(existsSync(fullPath), `expected ${doc.relativePath} to exist`);
        assert.strictEqual(readFileSync(fullPath, "utf8"), doc.contents);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("is a no-op when bundleDir is falsy", async () => {
    await assert.doesNotReject(() => writeOkfBundle(null, [{ relativePath: "index.md", contents: "x" }]));
  });
});

describe("formatOkfBundleResult", () => {
  it("reports format, repository, and exported count", () => {
    const report = formatOkfBundleResult({
      bundleDir: null,
      repository: "acme/widgets",
      exportedArtifactCount: 2,
    });
    assert.match(report, /format: okf/u);
    assert.match(report, /repository: acme\/widgets/u);
    assert.match(report, /exportedImprovementCount: 2/u);
    assert.match(report, /bundlePath: inline/u);
  });

  it("defaults repository to global and count to 0", () => {
    const report = formatOkfBundleResult({ bundleDir: null });
    assert.match(report, /repository: global/u);
    assert.match(report, /exportedImprovementCount: 0/u);
  });

  it("reports bundlePath relative to the Lore package root, not an ancestor of it", () => {
    // This module lives at <repo>/lib/memory-tools-okf-bundle.mjs, one level
    // below the actual repo root. repoRootFromModule() previously resolved
    // three levels up (landing outside the repo), which produced a
    // bundlePath with a leading "../..".
    const repoRoot = path.resolve(new URL("../../", import.meta.url).pathname);
    const bundleDir = path.join(repoRoot, "tmp", "okf-bundle");
    const report = formatOkfBundleResult({
      bundleDir,
      repository: "acme/widgets",
      exportedArtifactCount: 1,
    });
    assert.match(report, /bundlePath: tmp\/okf-bundle/u);
    assert.ok(!report.includes(".."), `expected no ".." in bundlePath, got: ${report}`);
  });
});
