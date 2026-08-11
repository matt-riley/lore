import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  readGeneratedArtifactIntegrityEnabled,
  readProposalGenerationEnabled,
} from "./rollout-flags.mjs";
import { resolveCopilotRoot } from "./repository-utils.mjs";

const REVIEW_STATES = Object.freeze(["draft", "approved", "rejected", "superseded"]);

const PROPOSAL_TYPE_DIRECTORIES = Object.freeze({
  skill: "skill-enhancements",
  instruction_update: "instruction-updates",
  extension_heuristic: "extension-heuristics",
});

function nowIso() {
  return new Date().toISOString();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "proposal";
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function coerceReviewState(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return REVIEW_STATES.includes(normalized) ? normalized : "draft";
}

function repoRootFromConfig(config) {
  return resolveCopilotRoot(config, import.meta.url);
}

function proposalDocsRoot(config) {
  return path.join(repoRootFromConfig(config), "extensions", "lore", "docs", "proposals");
}

function relativePathFromRepo(config, absolutePath) {
  return path.relative(repoRootFromConfig(config), absolutePath).replaceAll(path.sep, "/");
}

function inferProposalType(artifact) {
  const corpus = [
    artifact.title,
    artifact.summary,
    JSON.stringify(artifact.evidence ?? {}),
    JSON.stringify(artifact.trace ?? {}),
  ].join(" ").toLowerCase();
  if (/\bskill\b/.test(corpus)) {
    return "skill";
  }
  if (/\binstruction|instructions|rule\b/.test(corpus) || artifact.source_kind === "session") {
    return "instruction_update";
  }
  return "extension_heuristic";
}

function formatEvidenceList(artifact) {
  const entries = [];
  for (const [key, value] of Object.entries(artifact.evidence ?? {})) {
    if (value == null) {
      continue;
    }
    entries.push(`- ${key}: \`${JSON.stringify(value)}\``);
  }
  if (entries.length === 0) {
    entries.push("- none recorded");
  }
  return entries.join("\n");
}

function formatTraceList(artifact) {
  const entries = [];
  for (const [key, value] of Object.entries(artifact.trace ?? {})) {
    if (value == null) {
      continue;
    }
    entries.push(`- ${key}: \`${JSON.stringify(value)}\``);
  }
  if (entries.length === 0) {
    entries.push("- none recorded");
  }
  return entries.join("\n");
}

function renderProposalContent({
  artifact,
  proposalId,
  proposalType,
  reviewState,
  proposalPath,
  generatedAt,
}) {
  return [
    "---",
    `proposal_id: ${proposalId}`,
    `proposal_type: ${proposalType}`,
    `status: ${reviewState}`,
    `source_backlog_id: ${artifact.id}`,
    `source_kind: ${artifact.source_kind}`,
    `generated_at: ${generatedAt}`,
    "---",
    "",
    `# Proposal: ${artifact.title}`,
    "",
    "## Provenance",
    "",
    `- Backlog artifact: \`${artifact.id}\``,
    `- Source case: \`${artifact.source_kind}:${artifact.source_case_id}\``,
    `- Linked memory: \`${artifact.linked_memory_id ?? "none"}\``,
    `- Generated artifact path: \`${proposalPath}\``,
    "",
    "## Current State",
    "",
    artifact.summary,
    "",
    "## Proposed Change",
    "",
    `- Proposal type: \`${proposalType}\``,
    "- Keep this change review-gated; do not auto-edit trusted source files.",
    "- Use the evidence below to decide whether the follow-on implementation belongs in skills, instructions, or Lore heuristics.",
    "",
    "## Supporting Evidence",
    "",
    formatEvidenceList(artifact),
    "",
    "## Trace Signals",
    "",
    formatTraceList(artifact),
    "",
    "## Review State",
    "",
    `- Current: \`${reviewState}\``,
    `- Valid values: ${REVIEW_STATES.map((value) => `\`${value}\``).join(", ")}`,
    "",
    "## Acceptance Criteria",
    "",
    "- The proposal remains additive and review-gated.",
    "- A human can trace the proposal back to concrete backlog evidence.",
    "- Any follow-on implementation can be validated with existing Lore validation, replay, or router evaluation flows.",
    "",
  ].join("\n");
}

function renderProposalIndex(rows) {
  const lines = [
    "# Generated Lore Proposals",
    "",
    "Review-gated artifacts generated from the Lore evolution ledger.",
    "",
    "## Review State Contract",
    "",
    `- Valid values: ${REVIEW_STATES.map((value) => `\`${value}\``).join(", ")}`,
    "- `draft`: generated and awaiting review",
    "- `approved`: reviewed and accepted for implementation",
    "- `rejected`: reviewed and intentionally declined",
    "- `superseded`: replaced by a newer proposal or artifact",
    "",
    "## Proposals",
    "",
  ];
  if (rows.length === 0) {
    lines.push("- No proposal artifacts have been generated yet.");
  } else {
    for (const row of rows) {
      lines.push(
        `- [${row.title}](${row.proposal_path}) artifact=\`${row.id}\` type=\`${row.proposal_type ?? "unknown"}\` reviewState=\`${row.review_state ?? "draft"}\` updated=\`${row.updated_at}\``,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function ensureProposalDirectory(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

function buildProposalAbsolutePath({ artifact, proposalType, config }) {
  const directory = PROPOSAL_TYPE_DIRECTORIES[proposalType] ?? PROPOSAL_TYPE_DIRECTORIES.extension_heuristic;
  const datePrefix = String(artifact.updated_at || artifact.created_at || nowIso()).slice(0, 10);
  const filename = `${datePrefix}-${slugify(artifact.title)}-${artifact.id.slice(0, 8)}.md`;
  return path.join(proposalDocsRoot(config), directory, filename);
}

function collectCandidates({ runtime, ids = [], limit = 10, updatedBefore = null }) {
  if (Array.isArray(ids) && ids.length > 0) {
    return ids
      .map((id) => runtime.db.getImprovementArtifact(id))
      .filter(Boolean);
  }
  return runtime.db.listImprovementArtifacts({
    status: "active",
    updatedBefore,
    sort: "updated_asc",
    limit,
  });
}

async function writeProposalIndex(runtime) {
  const rows = runtime.db.listImprovementArtifacts({
    hasProposal: true,
    limit: 200,
  });
  const indexPath = path.join(proposalDocsRoot(runtime.config), "PROPOSAL_INDEX.md");
  await ensureProposalDirectory(path.dirname(indexPath));
  await writeFile(indexPath, renderProposalIndex(rows), "utf8");
  return relativePathFromRepo(runtime.config, indexPath);
}

export async function generateProposalArtifacts({
  runtime,
  ids = [],
  limit = 10,
  updatedBefore = null,
  force = false,
  dryRun = false,
} = {}) {
  if (!readProposalGenerationEnabled(runtime.config)) {
    return {
      enabled: false,
      generatedCount: 0,
      skippedCount: 0,
      generated: [],
      skipped: [],
    };
  }

  const generatedAt = nowIso();
  const candidates = collectCandidates({ runtime, ids, limit, updatedBefore });
  const generated = [];
  const skipped = [];

  for (const artifact of candidates) {
    if (artifact.status !== "active") {
      skipped.push({ id: artifact.id, reason: "not_active" });
      continue;
    }
    if (artifact.proposal_path && !force) {
      skipped.push({ id: artifact.id, reason: "proposal_exists", proposalPath: artifact.proposal_path });
      continue;
    }

    const proposalType = inferProposalType(artifact);
    const absolutePath = buildProposalAbsolutePath({ artifact, proposalType, config: runtime.config });
    const proposalPath = relativePathFromRepo(runtime.config, absolutePath);
    const reviewState = coerceReviewState(artifact.review_state);
    const proposalId = artifact.id;
    const content = renderProposalContent({
      artifact,
      proposalId,
      proposalType,
      reviewState,
      proposalPath,
      generatedAt,
    });
    const proposalHash = sha256(content);

    if (!dryRun) {
      await ensureProposalDirectory(path.dirname(absolutePath));
      await writeFile(absolutePath, content, "utf8");
      runtime.db.setImprovementArtifactProposal({
        id: artifact.id,
        proposalType,
        proposalPath,
        proposalHash,
        reviewState,
        reviewRequestedAt: generatedAt,
        reviewRequestedBy: "proposal-generator",
        reviewerDecision: artifact.reviewer_decision ?? null,
        reviewerNotes: artifact.reviewer_notes ?? {},
      });
    }

    generated.push({
      id: artifact.id,
      proposalType,
      proposalPath,
      reviewState,
      proposalHash,
    });
  }

  let indexPath = null;
  if (!dryRun && generated.length > 0) {
    indexPath = await writeProposalIndex(runtime);
  }

  return {
    enabled: true,
    generatedCount: generated.length,
    skippedCount: skipped.length,
    generated,
    skipped,
    indexPath,
  };
}

export async function verifyProposalArtifacts({
  runtime,
  limit = 20,
  repair = false,
  dryRun = false,
} = {}) {
  if (!readGeneratedArtifactIntegrityEnabled(runtime.config)) {
    return {
      enabled: false,
      issueCount: 0,
      repairedCount: 0,
      issues: [],
      repaired: [],
    };
  }

  const rows = runtime.db.listImprovementArtifacts({
    hasProposal: true,
    limit,
  });
  const issues = [];
  const repaired = [];

  for (const row of rows) {
    const verification = await verifyProposalArtifactRow({ row, runtime, repair, dryRun });
    issues.push(...verification.issues);
    repaired.push(...verification.repaired);
  }

  const indexVerification = await verifyProposalIndexArtifacts({
    runtime,
    rows,
    limit,
    repair,
    dryRun,
  });
  issues.push(...indexVerification.issues);
  repaired.push(...indexVerification.repaired);

  return {
    enabled: true,
    issueCount: issues.length,
    repairedCount: repaired.length,
    issues,
    repaired,
    indexPath: indexVerification.indexPath,
  };
}

function buildProposalVerificationState(row, config) {
  const proposalType = row.proposal_type ?? inferProposalType(row);
  const absolutePath = row.proposal_path
    ? path.join(repoRootFromConfig(config), row.proposal_path)
    : buildProposalAbsolutePath({ artifact: row, proposalType, config });
  const proposalPath = row.proposal_path ?? relativePathFromRepo(config, absolutePath);
  const reviewState = coerceReviewState(row.review_state);
  const generatedAt = row.review_requested_at ?? row.updated_at ?? row.created_at ?? nowIso();
  const content = renderProposalContent({
    artifact: row,
    proposalId: row.id,
    proposalType,
    reviewState,
    proposalPath,
    generatedAt,
  });
  return {
    absolutePath,
    content,
    expectedHash: sha256(content),
    generatedAt,
    proposalPath,
    proposalType,
    reviewState,
  };
}

function buildProposalIssue(id, type, proposalPath) {
  return { id, type, proposalPath };
}

function buildProposalUpdate(row, state) {
  return {
    id: row.id,
    proposalType: state.proposalType,
    proposalPath: state.proposalPath,
    proposalHash: state.expectedHash,
    reviewState: state.reviewState,
    reviewRequestedAt: row.review_requested_at ?? row.updated_at ?? nowIso(),
    reviewRequestedBy: row.review_requested_by ?? "proposal-generator",
    reviewerDecision: row.reviewer_decision ?? null,
    reviewerNotes: row.reviewer_notes ?? {},
  };
}

async function repairProposalArtifact({ runtime, row, state, type, dryRun, repair }) {
  if (!repair || dryRun) {
    return null;
  }
  await ensureProposalDirectory(path.dirname(state.absolutePath));
  await writeFile(state.absolutePath, state.content, "utf8");
  runtime.db.setImprovementArtifactProposal(buildProposalUpdate(row, state));
  return buildProposalIssue(row.id, type, state.proposalPath);
}

async function verifyProposalArtifactRow({ row, runtime, repair, dryRun }) {
  const state = buildProposalVerificationState(row, runtime.config);
  try {
    const actualHash = sha256(await readFile(state.absolutePath, "utf8"));
    if (row.proposal_hash === state.expectedHash && actualHash === state.expectedHash) {
      return { issues: [], repaired: [] };
    }

    const issue = buildProposalIssue(row.id, "content_drift", state.proposalPath);
    const repaired = await repairProposalArtifact({
      runtime,
      row,
      state,
      type: "content_drift",
      repair,
      dryRun,
    });
    return {
      issues: [issue],
      repaired: repaired ? [repaired] : [],
    };
  } catch {
    const issue = buildProposalIssue(row.id, "missing_file", state.proposalPath);
    const repaired = await repairProposalArtifact({
      runtime,
      row,
      state,
      type: "missing_file",
      repair,
      dryRun,
    });
    return {
      issues: [issue],
      repaired: repaired ? [repaired] : [],
    };
  }
}

function buildProposalIndexState(rows, config) {
  const indexPath = path.join(proposalDocsRoot(config), "PROPOSAL_INDEX.md");
  return {
    indexPath,
    proposalPath: relativePathFromRepo(config, indexPath),
    expectedContent: renderProposalIndex(rows),
  };
}

async function repairProposalIndex({ state, repair, dryRun, repaired, type }) {
  if (!repair || dryRun) {
    return;
  }
  await ensureProposalDirectory(path.dirname(state.indexPath));
  await writeFile(state.indexPath, state.expectedContent, "utf8");
  repaired.push(buildProposalIssue("proposal-index", type, state.proposalPath));
}

async function verifyProposalIndexArtifacts({ runtime, rows, limit, repair, dryRun }) {
  const indexRows = repair && !dryRun
    ? runtime.db.listImprovementArtifacts({
      hasProposal: true,
      limit,
    })
    : rows;
  const state = buildProposalIndexState(indexRows, runtime.config);
  const issues = [];
  const repaired = [];

  try {
    const indexContent = await readFile(state.indexPath, "utf8");
    if (indexContent !== state.expectedContent) {
      issues.push(buildProposalIssue("proposal-index", "index_drift", state.proposalPath));
      await repairProposalIndex({ state, repair, dryRun, repaired, type: "index_drift" });
    }
  } catch {
    issues.push(buildProposalIssue("proposal-index", "missing_index", state.proposalPath));
    await repairProposalIndex({ state, repair, dryRun, repaired, type: "missing_index" });
  }

  return {
    indexPath: state.proposalPath,
    issues,
    repaired,
  };
}
