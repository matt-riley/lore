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
 *     embedded JSON <script type="application/json"> block, and the
 *     client-side detail-panel renderer escapes/sanitizes concept fields
 *     before writing them into innerHTML.
 *   - Client-side relative-link resolution: resolveRelativeId normalizes
 *     "./" and "../" path segments the same way the server-side bundle
 *     reader does.
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

function extractScriptBlock(html) {
  const match = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(match, "expected an inline <script> block before </body>");
  return match[1];
}

// Pulls a top-level `function name(...) { ... }` declaration out of the
// generated client script by brace-matching, so the pure helper functions
// (escapeHtml, isSafeResourceUrl, normalizePathSegments, resolveRelativeId)
// can be exercised directly without a DOM/cytoscape/marked environment.
function extractFunction(source, name) {
  const startIdx = source.indexOf(`function ${name}(`);
  assert.ok(startIdx !== -1, `expected to find function ${name} in generated script`);
  const braceStart = source.indexOf("{", startIdx);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(startIdx, i + 1);
}

function loadClientHelpers(html) {
  const script = extractScriptBlock(html);
  const fnSource = [
    "escapeHtml",
    "isSafeResourceUrl",
    "normalizePathSegments",
    "isInternalMarkdownHref",
    "isAbsoluteHref",
    "resolveRelativeId",
  ]
    .map((name) => extractFunction(script, name))
    .join("\n");
  const factory = new Function(
    `${fnSource}\nreturn { escapeHtml, isSafeResourceUrl, normalizePathSegments, isInternalMarkdownHref, isAbsoluteHref, resolveRelativeId };`,
  );
  return factory();
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

  it("loads DOMPurify from a CDN to sanitize rendered markdown", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    assert.ok(html.includes("dompurify@3.1.6"));
    assert.ok(html.includes("DOMPurify.sanitize"));
  });

  it("pins CDN scripts with Subresource Integrity hashes", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const scriptTags = [...html.matchAll(/<script src="https:\/\/[^"]+"[^>]*><\/script>/gu)].map((m) => m[0]);
    assert.equal(scriptTags.length, 3, "expected exactly 3 CDN <script> tags");
    for (const tag of scriptTags) {
      assert.match(tag, /integrity="sha384-[A-Za-z0-9+/]+=*"/u, `missing SRI hash: ${tag}`);
      assert.match(tag, /crossorigin="anonymous"/u, `missing crossorigin attr: ${tag}`);
    }
  });
});

describe("client-side detail-panel escaping", () => {
  it("escapeHtml neutralizes HTML metacharacters", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const { escapeHtml } = loadClientHelpers(html);
    assert.equal(
      escapeHtml('<img src=x onerror=alert(1)>&"\''),
      "&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;",
    );
  });

  it("isSafeResourceUrl allows http(s) and relative URLs, rejects other schemes", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const { isSafeResourceUrl } = loadClientHelpers(html);
    assert.equal(isSafeResourceUrl("https://example.com/doc"), true);
    assert.equal(isSafeResourceUrl("http://example.com/doc"), true);
    assert.equal(isSafeResourceUrl("./relative/path.md"), true);
    assert.equal(isSafeResourceUrl("relative/path.md"), true);
    assert.equal(isSafeResourceUrl("javascript:alert(1)"), false);
    assert.equal(isSafeResourceUrl("data:text/html,<script>alert(1)</script>"), false);
    assert.equal(isSafeResourceUrl("//evil.example/x"), false);
    assert.equal(isSafeResourceUrl(""), false);
    assert.equal(isSafeResourceUrl(null), false);
  });

  it("isSafeResourceUrl rejects unsafe schemes even with leading/trailing whitespace", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const { isSafeResourceUrl } = loadClientHelpers(html);
    assert.equal(isSafeResourceUrl(" javascript:alert(1)"), false);
    assert.equal(isSafeResourceUrl("\tjavascript:alert(1)"), false);
    assert.equal(isSafeResourceUrl("javascript:alert(1) "), false);
    assert.equal(isSafeResourceUrl("  //evil.example/x"), false);
    assert.equal(isSafeResourceUrl("   "), false);
    assert.equal(isSafeResourceUrl(" https://example.com/doc "), true);
  });

  it("normalizePathSegments collapses '.' and '..' segments", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const { normalizePathSegments } = loadClientHelpers(html);
    assert.equal(normalizePathSegments("a2"), "a2");
    assert.equal(normalizePathSegments("./a2"), "a2");
    assert.equal(normalizePathSegments("artifacts/./a2"), "artifacts/a2");
    assert.equal(normalizePathSegments("artifacts/../artifacts/a2"), "artifacts/a2");
  });

  it("normalizePathSegments retains unresolvable leading '..' segments instead of dropping them", () => {
    // A no-op pop() on an empty result array used to silently discard
    // leading ".." segments, letting a bundle-escaping link like
    // "../../artifacts/a2.md" incorrectly normalize to a valid in-bundle id
    // ("artifacts/a2"). The server-side reader (path.posix.normalize) keeps
    // unresolvable ".." segments, so the client must too, to stay consistent
    // and to make such links correctly fail to resolve to any concept.
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const { normalizePathSegments } = loadClientHelpers(html);
    assert.equal(normalizePathSegments("../../other/a2"), "../../other/a2");
    assert.equal(normalizePathSegments("../a2"), "../a2");
    assert.equal(normalizePathSegments("artifacts/../../a2"), "../a2");
  });

  it("resolveRelativeId resolves './' and '../' links to normalized ids", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const { resolveRelativeId } = loadClientHelpers(html);
    assert.equal(resolveRelativeId("./a2.md", "artifacts/a1"), "artifacts/a2");
    assert.equal(resolveRelativeId("../artifacts/a2.md", "artifacts/sub/a1"), "artifacts/artifacts/a2");
    assert.equal(resolveRelativeId("/artifacts/a2.md", "artifacts/a1"), "artifacts/a2");
  });

  it("resolveRelativeId does not let a bundle-escaping link resolve to an unrelated valid concept id", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const { resolveRelativeId } = loadClientHelpers(html);
    // From "artifacts/a1", "../../artifacts/a2.md" escapes above the bundle
    // root. It must NOT resolve to the real "artifacts/a2" concept id.
    const target = resolveRelativeId("../../artifacts/a2.md", "artifacts/a1");
    assert.notEqual(target, "artifacts/a2");
    assert.match(target, /^\.\./);
  });

  it("resolveRelativeId strips both anchors and query strings before matching the .md suffix", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const { resolveRelativeId } = loadClientHelpers(html);
    assert.equal(resolveRelativeId("./a2.md#section", "artifacts/a1"), "artifacts/a2");
    assert.equal(resolveRelativeId("./a2.md?x=1", "artifacts/a1"), "artifacts/a2");
    assert.equal(resolveRelativeId("./a2.md?x=1#section", "artifacts/a1"), "artifacts/a2");
  });

  it("isInternalMarkdownHref recognizes .md links even with anchors/query strings, rejects others", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const { isInternalMarkdownHref } = loadClientHelpers(html);
    assert.equal(isInternalMarkdownHref("./a2.md"), true);
    assert.equal(isInternalMarkdownHref("./a2.md#section"), true);
    assert.equal(isInternalMarkdownHref("./a2.md?x=1"), true);
    assert.equal(isInternalMarkdownHref("./a2.md?x=1#section"), true);
    assert.equal(isInternalMarkdownHref("https://example.com/x.md"), true);
    assert.equal(isInternalMarkdownHref("https://example.com/x"), false);
    assert.equal(isInternalMarkdownHref("docs/proposals/retry.md"), true);
  });

  it("isAbsoluteHref recognizes scheme-based and protocol-relative URLs, rejects relative paths", () => {
    const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
    const { isAbsoluteHref } = loadClientHelpers(html);
    assert.equal(isAbsoluteHref("https://example.com/x.md"), true);
    assert.equal(isAbsoluteHref("http://example.com/x.md"), true);
    assert.equal(isAbsoluteHref("mailto:a@example.com"), true);
    assert.equal(isAbsoluteHref("//evil.example/x.md"), true);
    assert.equal(isAbsoluteHref("./a2.md"), false);
    assert.equal(isAbsoluteHref("../artifacts/a2.md"), false);
    assert.equal(isAbsoluteHref("/artifacts/a2.md"), false);
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

  it("creates missing parent directories before writing", async () => {
    const tmpDir = makeTmpDir();
    try {
      const outPath = path.join(tmpDir, "nested", "sub", "viz.html");
      const html = renderOkfVisualizerHtml({ bundle: sampleBundle(), name: "Example" });
      await writeOkfVisualizerHtml(outPath, html);
      const written = readFileSync(outPath, "utf8");
      assert.equal(written, html);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
