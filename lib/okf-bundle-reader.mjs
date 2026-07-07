import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const RESERVED_FILENAMES = new Set(["index.md", "log.md"]);
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Reads any Open Knowledge Format (OKF v0.1, see
 * https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
 * bundle directory from disk into an in-memory graph model: one node per
 * concept document (reserved filenames index.md/log.md are skipped, per
 * OKF SPEC.md section 3) plus resolved internal-link edges between them.
 */
export async function readOkfBundle(bundleDir) {
  const files = await walkMarkdownFiles(bundleDir);
  const concepts = [];
  for (const filePath of files) {
    if (RESERVED_FILENAMES.has(path.basename(filePath))) {
      continue;
    }
    const relativePath = path.relative(bundleDir, filePath).replaceAll(path.sep, "/");
    const raw = await readFile(filePath, "utf8");
    concepts.push(buildConceptFromDocument(relativePath, raw));
  }
  const { edges, backlinksById } = buildOkfGraph(concepts);
  return { bundleDir, concepts, edges, backlinksById };
}

/** Pure: turns one raw markdown+frontmatter file's contents into a concept record. */
export function buildConceptFromDocument(relativePath, raw) {
  const conceptId = relativePath.replace(/\.md$/u, "");
  const { frontmatter, body } = parseOkfDocument(raw);
  return {
    id: conceptId,
    relativePath,
    type: typeof frontmatter.type === "string" && frontmatter.type ? frontmatter.type : "Concept",
    title: typeof frontmatter.title === "string" && frontmatter.title ? frontmatter.title : conceptId,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    resource: typeof frontmatter.resource === "string" ? frontmatter.resource : null,
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [],
    timestamp: typeof frontmatter.timestamp === "string" ? frontmatter.timestamp : null,
    frontmatter,
    body,
  };
}

/** Pure: splits a markdown file's raw text into its frontmatter object and body. */
export function parseOkfDocument(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const [, yamlBlock, body] = match;
  return { frontmatter: parseFrontmatterYaml(yamlBlock), body: body.replace(/^\r?\n/u, "") };
}

/**
 * Minimal, forgiving YAML-subset parser for OKF frontmatter blocks: flat
 * `key: value` pairs and `key: [item, item]` flow arrays, with quoted or
 * bare scalars. Not a general YAML parser (no nested maps, no multi-line
 * scalars) -- OKF frontmatter is deliberately flat, so this is sufficient
 * for both this project's own exports and the spec's own examples.
 */
export function parseFrontmatterYaml(yamlText) {
  const result = {};
  for (const rawLine of yamlText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/u);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    result[key] = parseYamlValue(rawValue.trim());
  }
  return result;
}

function parseYamlValue(raw) {
  if (raw === "") {
    return "";
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    return inner ? splitYamlFlowItems(inner).map(parseYamlScalar) : [];
  }
  return parseYamlScalar(raw);
}

function splitYamlFlowItems(inner) {
  const items = [];
  let current = "";
  let quoteChar = null;
  for (const ch of inner) {
    if (quoteChar) {
      current += ch;
      if (ch === quoteChar) {
        quoteChar = null;
      }
    } else if (ch === "\"" || ch === "'") {
      quoteChar = ch;
      current += ch;
    } else if (ch === ",") {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    items.push(current.trim());
  }
  return items;
}

function parseYamlScalar(raw) {
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    const inner = raw.slice(1, -1);
    return raw.startsWith("\"") ? inner.replace(/\\"/gu, "\"") : inner;
  }
  if (raw === "null" || raw === "~") {
    return null;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/u.test(raw)) {
    return Number(raw);
  }
  return raw;
}

/**
 * Pure: resolves markdown links between already-parsed concepts into graph
 * edges, per OKF SPEC.md section 5 (absolute bundle-relative links start
 * with `/`; otherwise links are relative to the linking concept's own
 * directory). External URLs (citations) are ignored -- only links that
 * resolve to another concept in the same bundle become graph edges.
 * Consumers MUST tolerate broken links (SPEC.md section 5), so unresolved
 * targets are silently skipped rather than treated as errors.
 */
export function buildOkfGraph(concepts) {
  const idSet = new Set(concepts.map((concept) => concept.id));
  const edges = [];
  const backlinksById = new Map(concepts.map((concept) => [concept.id, []]));

  for (const concept of concepts) {
    const conceptDir = path.posix.dirname(concept.relativePath);
    let match;
    MARKDOWN_LINK_RE.lastIndex = 0;
    while ((match = MARKDOWN_LINK_RE.exec(concept.body)) !== null) {
      const targetId = resolveOkfLinkTarget(match[2], conceptDir);
      if (targetId && targetId !== concept.id && idSet.has(targetId)) {
        edges.push({ source: concept.id, target: targetId });
        backlinksById.get(targetId).push(concept.id);
      }
    }
  }
  return { edges, backlinksById };
}

function resolveOkfLinkTarget(rawTarget, conceptDir) {
  const withoutAnchor = rawTarget.split("#")[0];
  if (!withoutAnchor || EXTERNAL_URL_RE.test(withoutAnchor)) {
    return null;
  }
  const relPath = withoutAnchor.startsWith("/")
    ? withoutAnchor.slice(1)
    : path.posix.join(conceptDir, withoutAnchor);
  const normalized = path.posix.normalize(relPath);
  return normalized.endsWith(".md") ? normalized.replace(/\.md$/u, "") : null;
}

async function walkMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}
