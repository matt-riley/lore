import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OKF_VERSION = "0.1";
const OKF_SPEC_URL = "https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md";

/**
 * Build an Open Knowledge Format (OKF v0.1) conformant bundle from the same
 * approved improvement artifacts memory_portable_bundle's json format exports.
 * Pure/no I/O: returns [{ relativePath, contents }, ...] ready to be written
 * to disk by writeOkfBundle.
 */
export function buildOkfBundleDocuments({ repository, improvementArtifacts, exportedAt } = {}) {
  const generatedAt = exportedAt ?? new Date().toISOString();
  const artifacts = Array.isArray(improvementArtifacts) ? improvementArtifacts : [];
  const seenSlugs = new Set();
  const concepts = artifacts.map((artifact) => buildArtifactConcept(artifact, seenSlugs));

  return [
    buildIndexDocument({ repository, concepts, generatedAt }),
    ...concepts.map(({ relativePath, contents }) => ({ relativePath, contents })),
  ];
}

/** Writes previously built OKF documents under bundleDir, creating directories as needed. */
export async function writeOkfBundle(bundleDir, documents) {
  if (!bundleDir) {
    return;
  }
  for (const doc of documents) {
    const fullPath = path.join(bundleDir, doc.relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, doc.contents, "utf8");
  }
}

export function formatOkfBundleResult({ bundleDir, repository, exportedArtifactCount = 0 }) {
  return [
    "action: export",
    "format: okf",
    `bundlePath: ${bundleDir ? path.relative(repoRootFromModule(), bundleDir).replaceAll(path.sep, "/") : "inline"}`,
    `repository: ${repository ?? "global"}`,
    `exportedImprovementCount: ${exportedArtifactCount}`,
    "",
    "Notes:",
    "- OKF bundles are local-first and review-gated, same as the json format",
    "- bundle includes approved improvement artifacts only",
    `- conformant with Open Knowledge Format v${OKF_VERSION} (${OKF_SPEC_URL})`,
  ].filter(Boolean).join("\n");
}

function buildIndexDocument({ repository, concepts, generatedAt }) {
  const frontmatter = yamlFrontmatter({ okf_version: OKF_VERSION });
  const lines = [
    frontmatter,
    "",
    "# Lore Improvement Artifacts",
    "",
    `Portable OKF export of approved Lore improvement artifacts${repository ? ` for \`${repository}\`` : ""}, generated ${generatedAt}.`,
    "",
  ];
  if (concepts.length === 0) {
    lines.push("_No approved improvement artifacts to export._");
  } else {
    lines.push("# Improvement Artifacts");
    lines.push("");
    for (const concept of concepts) {
      const description = concept.description ? ` - ${concept.description}` : "";
      lines.push(`- [${concept.title}](${concept.relativePath})${description}`);
    }
  }
  return { relativePath: "index.md", contents: `${lines.join("\n").trimEnd()}\n` };
}

function buildArtifactConcept(artifact, seenSlugs) {
  const {
    id,
    sourceCaseId,
    sourceKind,
    title: artifactTitle,
    summary,
    status,
    reviewState,
    proposal = {},
    evidence = {},
    updatedAt,
    createdAt,
  } = artifact ?? {};
  const slug = uniqueSlug(id ?? sourceCaseId ?? "artifact", seenSlugs);
  const relativePath = `artifacts/${slug}.md`;
  const title = artifactTitle || slug;
  const tags = [...new Set([sourceKind, status, reviewState].filter(Boolean))];

  const frontmatter = yamlFrontmatter({
    type: "Improvement Artifact",
    title,
    description: summary || undefined,
    resource: proposal.path || undefined,
    tags,
    timestamp: updatedAt || createdAt || undefined,
    sourceCaseId,
    sourceKind,
    status,
    reviewState,
  });

  const body = [];
  body.push(`# ${title}`);
  body.push("");
  if (summary) {
    body.push(summary);
    body.push("");
  }
  if (proposal.type || proposal.path || proposal.hash) {
    body.push("# Proposal");
    body.push("");
    if (proposal.type) body.push(`- **Type**: ${proposal.type}`);
    if (proposal.path) body.push(`- **Path**: \`${proposal.path}\``);
    if (proposal.hash) body.push(`- **Hash**: \`${proposal.hash}\``);
    body.push("");
  }
  if (Object.keys(evidence).length > 0) {
    body.push("# Evidence");
    body.push("");
    body.push("```json");
    body.push(JSON.stringify(evidence, null, 2));
    body.push("```");
    body.push("");
  }

  const contents = `${frontmatter}\n\n${body.join("\n").trimEnd()}\n`;
  return { relativePath, contents, title, description: summary || "" };
}

function uniqueSlug(rawValue, seenSlugs) {
  const base = slugify(rawValue);
  let candidate = base;
  let suffix = 2;
  while (seenSlugs.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  seenSlugs.add(candidate);
  return candidate;
}

function slugify(value) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "artifact";
}

function yamlScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(String(value));
}

/** Minimal, safe YAML frontmatter serializer: every scalar is JSON-quoted (a valid YAML subset), skips empty/undefined fields. */
function yamlFrontmatter(fields) {
  const lines = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        continue;
      }
      lines.push(`${key}: [${value.map((item) => yamlScalar(item)).join(", ")}]`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  return ["---", ...lines, "---"].join("\n");
}

function repoRootFromModule() {
  // This module lives at <repo>/lib/memory-tools-okf-bundle.mjs, so one
  // level up from its directory is the actual repository root (mirrors the
  // fix in memory-tools-portable-bundle.mjs's repoRootFromModule()).
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
