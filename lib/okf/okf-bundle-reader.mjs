import { open, readdir } from "node:fs/promises";
import path from "node:path";

const RESERVED_FILENAMES = new Set(["index.md", "log.md"]);
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// Reads are bounded by default so one bundle (or one hostile document) cannot
// force unbounded disk I/O, memory retention, or graph work.
const DEFAULT_OKF_READ_LIMITS = Object.freeze({
  maxTraversalEntries: 10_000,
  maxDepth: 32,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
});

/**
 * Reads any Open Knowledge Format (OKF v0.1, see
 * https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
 * bundle directory from disk into an in-memory graph model: one node per
 * concept document (reserved filenames index.md/log.md are skipped, per
 * OKF SPEC.md section 3) plus resolved internal-link edges between them.
 *
 * `maxConcepts` bounds how many concept files are actually read/parsed.
 * Reads and traversal are also bounded regardless of `maxConcepts`: at most
 * `limits.maxTraversalEntries` directory entries, `limits.maxDepth` levels,
 * `limits.maxFileBytes` per document, and `limits.maxTotalBytes` across the
 * bundle. When any bound is hit the result sets `truncated` with
 * `truncationReasons` and lists `skippedFiles`, while `totalConceptFileCount`
 * reports the concept-eligible files seen before the bound. Callers like
 * memory_portable_bundle's action=import use this so one large bundle
 * directory can't force unbounded disk I/O/CPU/memory even though the amount
 * of memory actually retained is already capped.
 * `includeGraph` can be set to false to skip edge resolution entirely for
 * callers (like import) that only need the concept list, not the link graph.
 */
export async function readOkfBundle(bundleDir, { maxConcepts, includeGraph = true, limits = {} } = {}) {
  const effectiveLimits = { ...DEFAULT_OKF_READ_LIMITS, ...(limits ?? {}) };
  const walk = await walkMarkdownFiles(bundleDir, effectiveLimits);
  const conceptFiles = walk.files.filter((filePath) => !RESERVED_FILENAMES.has(path.basename(filePath)));
  const filesToRead = typeof maxConcepts === "number" ? conceptFiles.slice(0, maxConcepts) : conceptFiles;

  const concepts = [];
  const skippedFiles = [];
  const truncationReasons = new Set();
  if (walk.truncated) {
    truncationReasons.add("traversal_limit");
  }
  let totalBytes = 0;
  for (const filePath of filesToRead) {
    if (totalBytes >= effectiveLimits.maxTotalBytes) {
      truncationReasons.add("total_bytes_limit");
      break;
    }
    const relativePath = path.relative(bundleDir, filePath).replaceAll(path.sep, "/");
    const remainingBytes = effectiveLimits.maxTotalBytes - totalBytes;
    const readLimit = Math.min(effectiveLimits.maxFileBytes, remainingBytes);
    const read = await readFileBounded(filePath, readLimit);
    if (read.tooLarge) {
      if (remainingBytes < effectiveLimits.maxFileBytes) {
        truncationReasons.add("total_bytes_limit");
        break;
      }
      skippedFiles.push(relativePath);
      truncationReasons.add("file_size_limit");
      continue;
    }
    totalBytes += read.bytesRead;
    concepts.push(buildConceptFromDocument(relativePath, read.contents));
  }
  const { edges, backlinksById } = includeGraph
    ? buildOkfGraph(concepts)
    : { edges: [], backlinksById: new Map(concepts.map((concept) => [concept.id, []])) };
  return {
    bundleDir,
    concepts,
    edges,
    backlinksById,
    totalConceptFileCount: conceptFiles.length,
    readConceptFileCount: concepts.length,
    truncated: truncationReasons.size > 0,
    truncationReasons: [...truncationReasons],
    skippedFiles,
  };
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
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    // The OKF writer in this repo serializes double-quoted scalars via
    // JSON.stringify (a valid YAML subset), so JSON.parse is the correct
    // inverse -- it handles \\, \n, \t, \uXXXX, etc., not just \".
    try {
      return JSON.parse(raw);
    } catch {
      // Tolerate hand-authored/non-JSON double-quoted scalars per OKF
      // SPEC.md's "consumers must tolerate malformed content" guidance.
      return raw.slice(1, -1).replace(/\\"/gu, "\"");
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
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
  const withoutSuffix = rawTarget.split("#")[0].split("?")[0];
  if (!withoutSuffix || EXTERNAL_URL_RE.test(withoutSuffix)) {
    return null;
  }
  const relPath = withoutSuffix.startsWith("/")
    ? withoutSuffix.slice(1)
    : path.posix.join(conceptDir, withoutSuffix);
  const normalized = path.posix.normalize(relPath);
  return normalized.endsWith(".md") ? normalized.replace(/\.md$/u, "") : null;
}

async function readFileBounded(filePath, maxBytes) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) {
      return { tooLarge: true, bytesRead: 0 };
    }
    return { tooLarge: false, bytesRead, contents: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
}

async function walkMarkdownFiles(rootDir, { maxDepth, maxTraversalEntries }) {
  const files = [];
  let inspected = 0;
  let truncated = false;
  const visit = async (dirPath, depth) => {
    if (truncated) {
      return;
    }
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (inspected >= maxTraversalEntries) {
        truncated = true;
        return;
      }
      inspected += 1;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
      if (truncated) {
        return;
      }
    }
  };
  await visit(rootDir, 0);
  return { files, inspected, truncated };
}
