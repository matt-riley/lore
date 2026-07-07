/**
 * tests/unit/okf-bundle-reader.test.mjs
 *
 * Unit tests for lib/okf-bundle-reader.mjs.
 *
 * Covers:
 *   - parseFrontmatterYaml: flat key/value pairs, flow arrays, quoted and
 *     bare scalars, numbers/booleans/null.
 *   - parseOkfDocument: frontmatter/body split, and the no-frontmatter
 *     fallback.
 *   - buildOkfGraph: absolute (bundle-root-relative) and relative internal
 *     link resolution into edges + backlinks, external URLs ignored, and
 *     broken/unknown links tolerated (per OKF SPEC.md section 5).
 *   - readOkfBundle: full round-trip against a real bundle written by
 *     writeOkfBundle (lib/memory-tools-okf-bundle.mjs), including the
 *     reserved index.md/log.md filenames being excluded from concepts.
 *
 * Run:
 *   node --test tests/unit/okf-bundle-reader.test.mjs
 */

import { it, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseFrontmatterYaml,
  parseOkfDocument,
  buildConceptFromDocument,
  buildOkfGraph,
  readOkfBundle,
} from "../../lib/okf-bundle-reader.mjs";
import { buildOkfBundleDocuments, writeOkfBundle } from "../../lib/memory-tools-okf-bundle.mjs";

function makeTmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-okf-reader-test-"));
}

describe("parseFrontmatterYaml", () => {
  it("parses flat scalars, quoted strings, numbers, booleans, and null", () => {
    const parsed = parseFrontmatterYaml(
      [
        "type: BigQuery Table",
        'title: "Customer Orders"',
        "count: 42",
        "ratio: 1.5",
        "active: true",
        "archived: false",
        "owner: null",
      ].join("\n"),
    );
    assert.equal(parsed.type, "BigQuery Table");
    assert.equal(parsed.title, "Customer Orders");
    assert.equal(parsed.count, 42);
    assert.equal(parsed.ratio, 1.5);
    assert.equal(parsed.active, true);
    assert.equal(parsed.archived, false);
    assert.equal(parsed.owner, null);
  });

  it("parses flow arrays with bare and quoted items", () => {
    const parsed = parseFrontmatterYaml('tags: [sales, "orders, revenue", approved]');
    assert.deepEqual(parsed.tags, ["sales", "orders, revenue", "approved"]);
  });

  it("parses an empty flow array", () => {
    const parsed = parseFrontmatterYaml("tags: []");
    assert.deepEqual(parsed.tags, []);
  });

  it("ignores comments and blank lines", () => {
    const parsed = parseFrontmatterYaml("# a comment\n\ntype: Concept\n");
    assert.deepEqual(parsed, { type: "Concept" });
  });

  it("round-trips JSON-escaped double-quoted scalars written by yamlScalar (backslashes, newlines, tabs, unicode)", () => {
    // yamlFrontmatter()/yamlScalar() in memory-tools-okf-bundle.mjs always
    // serializes double-quoted scalars via JSON.stringify, so the reader
    // must reverse full JSON escaping, not just \" -> ".
    const value = "C:\\Users\\test\tline1\nline2 \u2603";
    const line = "title: " + JSON.stringify(value);
    const parsed = parseFrontmatterYaml(line);
    assert.equal(parsed.title, value);
  });

  it("falls back to a minimal unescape for non-JSON double-quoted scalars", () => {
    // "\d" is not a valid JSON escape, so JSON.parse throws and the reader
    // must fall back gracefully instead of losing the value.
    const parsed = parseFrontmatterYaml('title: "50% \\d discount"');
    assert.equal(parsed.title, "50% \\d discount");
  });
});

describe("parseOkfDocument", () => {
  it("splits frontmatter from body", () => {
    const raw = "---\ntype: Concept\ntitle: Example\n---\n\n# Example\n\nBody text.\n";
    const { frontmatter, body } = parseOkfDocument(raw);
    assert.equal(frontmatter.type, "Concept");
    assert.equal(frontmatter.title, "Example");
    assert.equal(body, "# Example\n\nBody text.\n");
  });

  it("treats content with no frontmatter delimiters as body-only", () => {
    const raw = "# Just markdown\n\nNo frontmatter here.\n";
    const { frontmatter, body } = parseOkfDocument(raw);
    assert.deepEqual(frontmatter, {});
    assert.equal(body, raw);
  });
});

describe("buildConceptFromDocument", () => {
  it("defaults type to Concept and title to the concept id when absent", () => {
    const concept = buildConceptFromDocument("artifacts/a1.md", "---\n---\nBody\n");
    assert.equal(concept.id, "artifacts/a1");
    assert.equal(concept.type, "Concept");
    assert.equal(concept.title, "artifacts/a1");
    assert.deepEqual(concept.tags, []);
  });
});

describe("buildOkfGraph", () => {
  function concept(relativePath, body, overrides = {}) {
    return {
      id: relativePath.replace(/\.md$/u, ""),
      relativePath,
      type: "Concept",
      title: relativePath,
      body,
      ...overrides,
    };
  }

  it("resolves bundle-root-relative absolute links", () => {
    const concepts = [
      concept("artifacts/a1.md", "See [related](/artifacts/a2.md)."),
      concept("artifacts/a2.md", "No links here."),
    ];
    const { edges, backlinksById } = buildOkfGraph(concepts);
    assert.deepEqual(edges, [{ source: "artifacts/a1", target: "artifacts/a2" }]);
    assert.deepEqual(backlinksById.get("artifacts/a2"), ["artifacts/a1"]);
  });

  it("resolves relative links against the linking concept's own directory", () => {
    const concepts = [
      concept("artifacts/a1.md", "See [related](./a2.md) and [up](../index.md)."),
      concept("artifacts/a2.md", "No links here."),
    ];
    const { edges } = buildOkfGraph(concepts);
    assert.deepEqual(edges, [{ source: "artifacts/a1", target: "artifacts/a2" }]);
  });

  it("ignores external URLs and unresolved/broken links", () => {
    const concepts = [
      concept("artifacts/a1.md", "See [external](https://example.com/a2.md) and [missing](./missing.md)."),
    ];
    const { edges } = buildOkfGraph(concepts);
    assert.deepEqual(edges, []);
  });

  it("does not self-link", () => {
    const concepts = [concept("artifacts/a1.md", "See [self](./a1.md).")];
    const { edges } = buildOkfGraph(concepts);
    assert.deepEqual(edges, []);
  });
});

describe("readOkfBundle (round-trip against writeOkfBundle)", () => {
  it("reads back concepts written by writeOkfBundle and excludes reserved filenames", async () => {
    const tmpDir = makeTmpDir();
    try {
      const artifacts = [
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
      ];
      const documents = buildOkfBundleDocuments({ improvementArtifacts: artifacts });
      await writeOkfBundle(tmpDir, documents);

      const bundle = await readOkfBundle(tmpDir);
      assert.equal(bundle.concepts.length, 1);
      assert.equal(bundle.concepts[0].type.length > 0, true);
      assert.ok(!bundle.concepts.some((concept) => concept.relativePath.endsWith("index.md")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
