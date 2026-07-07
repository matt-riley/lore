/**
 * tests/unit/okf-bundle-visualizer.test.mjs
 *
 * Unit tests for lib/okf-bundle-visualizer.mjs.
 *
 * Covers:
 *   - renderOkfVisualizerHtml: produces a single self-contained HTML
 *     document embedding the bundle as JSON, referencing Cytoscape.js and
 *     marked from CDN (no npm runtime dependency), and including the
 *     expected interactive-viewer scaffolding (graph container, detail
 *     panel, search, type filter).
 *   - writeOkfVisualizerHtml: writes the rendered HTML to disk.
 *   - HTML/script injection safety: bundle content cannot break out of the
 *     embedded JSON <script type="application/json"> block.
 *
 * Run:
 *   node --test tests/unit/okf-bundle-visualizer.test.mjs
 */

import { it, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderOkfVisualizerHtml, writeOkfVisualizerHtml } from "../../lib/okf-bundle-visualizer.mjs";

function makeTmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-okf-viz-test-"));
}

function sampleBundle() {
  return {
    bundleDir: "/tmp/example-bundle",
    concepts: [
      {
        id: "artifacts/a1",
        type: "Improvement Artifact",
        title: "Tighten retry backoff",
        description: "Reduce retry storms.",
        resource: null,
        tags: ["approved"],
        timestamp: "2026-01-01T00:00:00.000Z",
        body: "Body text with a [link](./a2.md).",
      },
      {
        id: "artifacts/a2",
        type: "Improvement Artifact",
        title: "Improve fallback",
        description: "",
        resource: null,
        tags: [],
        timestamp: "2026-01-03T00:00:00.000Z",
        body: "No links here.",
      },
    ],
    edges: [{ source: "artifacts/a1", target: "artifacts/a2" }],
  };
}

describe("renderOkfVisualizerHtml", () => {
  it("embeds the bundle as JSON and includes CDN script tags, not npm imports", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example Bundle" });
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("Example Bundle"));
    assert.ok(html.includes("cytoscape@3.30.2"));
    assert.ok(html.includes("marked@12.0.2"));
    assert.ok(html.includes('id="okf-bundle-data"'));
    assert.ok(html.includes('"id":"artifacts/a1"'));
    assert.ok(html.includes('"source":"artifacts/a1"'));
    assert.ok(html.includes('id="graph"'));
    assert.ok(html.includes('id="detail"'));
    assert.ok(html.includes('id="search"'));
    assert.ok(html.includes('id="typeFilter"'));
  });

  it("escapes the display name used in visible HTML", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "<script>alert(1)</script>" });
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("neutralizes literal </script> sequences inside embedded bundle JSON", () => {
    const bundle = sampleBundle();
    bundle.concepts[0].body = "</script><script>alert(1)</script>";
    const html = renderOkfVisualizerHtml({ bundle, name: "Example" });
    assert.ok(!html.includes("</script><script>alert(1)</script>"));
  });

  it("falls back to the bundle directory name when no name is given", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle() });
    assert.ok(html.includes("example-bundle"));
  });
});

describe("writeOkfVisualizerHtml", () => {
  it("writes the rendered HTML to the given path", async () => {
    const tmpDir = makeTmpDir();
    try {
      const outPath = path.join(tmpDir, "viz.html");
      const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
      await writeOkfVisualizerHtml(outPath, html);
      const written = readFileSync(outPath, "utf8");
      assert.equal(written, html);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
