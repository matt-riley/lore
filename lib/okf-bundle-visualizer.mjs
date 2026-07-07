import path from "node:path";
import { writeFile } from "node:fs/promises";

const TYPE_PALETTE = Object.freeze([
  "#5da8ff", "#ff9f5d", "#7ee2a8", "#e07df0", "#ffd75d", "#ff6b6b", "#5de0d9", "#c3a1ff",
]);

/**
 * Pure: renders a parsed OKF bundle (see readOkfBundle in okf-bundle-reader.mjs)
 * into a single self-contained HTML file. Mirrors the `visualize` subcommand
 * of the OKF reference agent (GoogleCloudPlatform/knowledge-catalog okf/):
 * a force-directed graph of concepts colored by type, a detail panel with
 * rendered markdown + backlinks, a search box, and a type filter. Cytoscape.js
 * and marked are loaded from CDN at view time -- no npm runtime dependency is
 * added to this zero-dependency package.
 */
export function renderOkfVisualizerHtml({ bundle, name }) {
  const displayName = escapeHtml(name || path.basename(bundle.bundleDir || "") || "OKF Bundle");
  const payload = {
    name: name || path.basename(bundle.bundleDir || "") || "OKF Bundle",
    concepts: bundle.concepts.map((concept) => ({
      id: concept.id,
      type: concept.type,
      title: concept.title,
      description: concept.description,
      resource: concept.resource,
      tags: concept.tags,
      timestamp: concept.timestamp,
      body: concept.body,
    })),
    edges: bundle.edges,
  };
  const embeddedJson = JSON.stringify(payload).replace(/</gu, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${displayName} — OKF bundle viewer</title>
<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>
<style>${STYLE_BLOCK}</style>
</head>
<body>
<div id="app">
  <header>
    <h1>${displayName}</h1>
    <div class="controls">
      <input id="search" type="search" placeholder="Search title, id, or tag..." />
      <select id="typeFilter"><option value="">All types</option></select>
      <select id="layoutSelect">
        <option value="cose">Force-directed (cose)</option>
        <option value="breadthfirst">Hierarchical</option>
        <option value="concentric">Concentric</option>
        <option value="circle">Circle</option>
        <option value="grid">Grid</option>
      </select>
      <span id="stats" class="stats"></span>
    </div>
  </header>
  <main>
    <div id="graph"></div>
    <aside id="detail">
      <div class="empty-state">Select a concept node to see its details.</div>
    </aside>
  </main>
</div>
<script id="okf-bundle-data" type="application/json">${embeddedJson}</script>
<script>${SCRIPT_BLOCK}</script>
</body>
</html>
`;
}

/** Writes a rendered visualizer HTML string to disk, creating no other files. */
export async function writeOkfVisualizerHtml(outPath, html) {
  await writeFile(outPath, html, "utf8");
  return outPath;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

export const OKF_VIZ_TYPE_PALETTE = TYPE_PALETTE;

const STYLE_BLOCK = `
  :root {
    --bg: #0f1117; --card: #171a23; --border: #262b38; --text: #e6e9f0; --muted: #8b93a7;
    --accent1: #5da8ff; --accent2: #7ee2a8; --accent3: #ff9f5d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #app { display: flex; flex-direction: column; height: 100vh; }
  header { padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--card); }
  header h1 { margin: 0 0 8px; font-size: 18px; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .controls input, .controls select { background: #0f1117; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  .stats { margin-left: auto; color: var(--muted); font-size: 12px; }
  main { flex: 1; display: flex; min-height: 0; }
  #graph { flex: 1; min-width: 0; }
  #detail { width: 380px; border-left: 1px solid var(--border); background: var(--card); padding: 16px; overflow-y: auto; }
  #detail .empty-state { color: var(--muted); font-size: 13px; }
  #detail h2 { margin: 0 0 4px; font-size: 16px; }
  #detail .type-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-bottom: 8px; color: #0f1117; font-weight: 600; }
  #detail .meta { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
  #detail .tags span { display: inline-block; background: #262b38; border-radius: 10px; padding: 2px 8px; font-size: 11px; margin: 0 4px 4px 0; }
  #detail .body { font-size: 13px; line-height: 1.5; border-top: 1px solid var(--border); padding-top: 10px; margin-top: 10px; }
  #detail .body a { color: var(--accent1); }
  #detail .backlinks { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
  #detail .backlinks h3 { font-size: 12px; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
  #detail .backlinks button { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--accent1); padding: 3px 0; cursor: pointer; font-size: 12px; }
  #detail .backlinks button:hover { text-decoration: underline; }
`;

const SCRIPT_BLOCK = `
(function () {
  var bundle = JSON.parse(document.getElementById("okf-bundle-data").textContent);
  var palette = ${JSON.stringify(TYPE_PALETTE)};
  var typeColors = {};
  var types = Array.from(new Set(bundle.concepts.map(function (c) { return c.type; }))).sort();
  types.forEach(function (t, i) { typeColors[t] = palette[i % palette.length]; });

  var conceptsById = {};
  bundle.concepts.forEach(function (c) { conceptsById[c.id] = c; });
  var backlinksById = {};
  bundle.concepts.forEach(function (c) { backlinksById[c.id] = []; });
  bundle.edges.forEach(function (e) {
    if (backlinksById[e.target]) backlinksById[e.target].push(e.source);
  });

  var typeFilterEl = document.getElementById("typeFilter");
  types.forEach(function (t) {
    var opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    typeFilterEl.appendChild(opt);
  });
  document.getElementById("stats").textContent = bundle.concepts.length + " concepts, " + bundle.edges.length + " links";

  var elements = bundle.concepts.map(function (c) {
    return { data: { id: c.id, label: c.title, type: c.type }, classes: "type-" + slug(c.type) };
  }).concat(bundle.edges.map(function (e) {
    return { data: { source: e.source, target: e.target } };
  }));

  var cy = cytoscape({
    container: document.getElementById("graph"),
    elements: elements,
    style: [
      { selector: "node", style: {
          "background-color": function (ele) { return typeColors[ele.data("type")] || "#5da8ff"; },
          "label": "data(label)", "color": "#e6e9f0", "font-size": 9,
          "text-valign": "bottom", "text-margin-y": 4, "width": 22, "height": 22, "text-wrap": "ellipsis", "text-max-width": "90px",
      } },
      { selector: "edge", style: { "width": 1, "line-color": "#3a4152", "target-arrow-color": "#3a4152", "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.6 } },
      { selector: ".faded", style: { "opacity": 0.12 } },
      { selector: "node:selected", style: { "border-width": 3, "border-color": "#ffd75d" } },
    ],
    layout: { name: "cose", animate: false },
  });

  function slug(v) { return String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-"); }

  function escapeHtml(value) {
    return String(value)
      .split("&").join("&amp;")
      .split("<").join("&lt;")
      .split(">").join("&gt;")
      .split('"').join("&quot;")
      .split("'").join("&#39;");
  }

  function isSafeResourceUrl(url) {
    if (!url) return false;
    if (/^https?:\\/\\//i.test(url)) return true;
    if (/^\\/\\//.test(url)) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
    return true;
  }

  function renderDetail(id) {
    var c = conceptsById[id];
    var detail = document.getElementById("detail");
    if (!c) { detail.innerHTML = '<div class="empty-state">Select a concept node to see its details.</div>'; return; }
    var color = typeColors[c.type] || "#5da8ff";
    var tagsHtml = (c.tags || []).map(function (t) { return "<span>" + escapeHtml(t) + "</span>"; }).join("");
    var rawBodyHtml = (typeof marked !== "undefined") ? marked.parse(c.body || "") : escapeHtml(c.body || "");
    var bodyHtml = (typeof DOMPurify !== "undefined") ? DOMPurify.sanitize(rawBodyHtml) : escapeHtml(c.body || "");
    var backlinks = backlinksById[id] || [];
    var backlinksHtml = backlinks.length
      ? "<div class=\\"backlinks\\"><h3>Cited by (" + backlinks.length + ")</h3>" +
        backlinks.map(function (b) {
          var bc = conceptsById[b];
          return '<button data-nav="' + escapeHtml(b) + '">' + escapeHtml(bc ? bc.title : b) + "</button>";
        }).join("") + "</div>"
      : "";
    var resourceHtml = (c.resource && isSafeResourceUrl(c.resource))
      ? " &middot; <a href=\\"" + escapeHtml(c.resource) + "\\" target=\\"_blank\\" rel=\\"noopener\\">source</a>"
      : "";
    detail.innerHTML =
      "<h2>" + escapeHtml(c.title) + "</h2>" +
      '<span class="type-badge" style="background:' + color + '">' + escapeHtml(c.type) + "</span>" +
      '<div class="meta">' + escapeHtml(c.timestamp || "") + resourceHtml + "</div>" +
      (c.description ? '<div class="meta">' + escapeHtml(c.description) + "</div>" : "") +
      (tagsHtml ? '<div class="tags">' + tagsHtml + "</div>" : "") +
      '<div class="body">' + bodyHtml + "</div>" +
      backlinksHtml;

    detail.querySelectorAll("a[href$='.md']").forEach(function (a) {
      a.addEventListener("click", function (evt) {
        evt.preventDefault();
        var target = resolveRelativeId(a.getAttribute("href"), id);
        if (conceptsById[target]) selectNode(target);
      });
    });
    detail.querySelectorAll("button[data-nav]").forEach(function (btn) {
      btn.addEventListener("click", function () { selectNode(btn.getAttribute("data-nav")); });
    });
  }

  function normalizePathSegments(pathStr) {
    var parts = pathStr.split("/");
    var result = [];
    parts.forEach(function (part) {
      if (part === "" || part === ".") return;
      if (part === "..") { result.pop(); return; }
      result.push(part);
    });
    return result.join("/");
  }

  function resolveRelativeId(href, currentId) {
    var withoutAnchor = href.split("#")[0].replace(/\\.md$/, "");
    if (withoutAnchor.indexOf("/") === 0) return normalizePathSegments(withoutAnchor.slice(1));
    var dir = currentId.indexOf("/") >= 0 ? currentId.slice(0, currentId.lastIndexOf("/")) : "";
    var joined = dir ? dir + "/" + withoutAnchor : withoutAnchor;
    return normalizePathSegments(joined);
  }

  function selectNode(id) {
    cy.elements().unselect();
    var node = cy.getElementById(id);
    if (node && node.length) { node.select(); cy.animate({ center: { eles: node } }, { duration: 200 }); }
    renderDetail(id);
  }

  cy.on("tap", "node", function (evt) { renderDetail(evt.target.id()); });

  document.getElementById("layoutSelect").addEventListener("change", function (evt) {
    cy.layout({ name: evt.target.value, animate: false }).run();
  });

  function applyFilters() {
    var query = document.getElementById("search").value.trim().toLowerCase();
    var typeFilter = typeFilterEl.value;
    cy.nodes().forEach(function (node) {
      var c = conceptsById[node.id()];
      var matchesType = !typeFilter || c.type === typeFilter;
      var matchesQuery = !query ||
        c.title.toLowerCase().indexOf(query) >= 0 ||
        c.id.toLowerCase().indexOf(query) >= 0 ||
        (c.tags || []).some(function (t) { return t.toLowerCase().indexOf(query) >= 0; });
      node.toggleClass("faded", !(matchesType && matchesQuery));
    });
  }
  document.getElementById("search").addEventListener("input", applyFilters);
  typeFilterEl.addEventListener("change", applyFilters);
})();
`;
