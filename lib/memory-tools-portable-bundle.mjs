import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveRepositoryArg,
} from "./memory-tools-input-utils.mjs";
import { ensureLimit } from "./memory-tools-validation-utils.mjs";

const PORTABLE_BUNDLE_EXPORT_ACTION = "export";
const PORTABLE_BUNDLE_VERSION = 1;
const PORTABLE_BUNDLE_TYPE = "lore-portable-improvement";
const PORTABLE_BUNDLE_FORMATS = ["json", "okf"];
const PORTABLE_BUNDLE_DEFAULT_FORMAT = "json";

function normalizePortableBundleAction(value) {
  return typeof value === "string" ? value : PORTABLE_BUNDLE_EXPORT_ACTION;
}

function normalizePortableBundleFormat(value) {
  if (value === undefined || value === null) {
    return PORTABLE_BUNDLE_DEFAULT_FORMAT;
  }
  if (!PORTABLE_BUNDLE_FORMATS.includes(value)) {
    throw new Error(`format must be one of: ${PORTABLE_BUNDLE_FORMATS.join(", ")}`);
  }
  return value;
}

export function buildPortableBundleRequest(args, runtime) {
  const action = normalizePortableBundleAction(args.action);
  if (action !== PORTABLE_BUNDLE_EXPORT_ACTION) {
    throw new Error("memory_portable_bundle currently supports action=export only");
  }
  const bundlePath = resolveBundlePath(args.bundlePath);
  if (args.bundlePath && !bundlePath) {
    throw new Error("bundlePath must be a non-empty path");
  }
  return {
    repository: resolveRepositoryArg(args.repository, runtime.repository),
    limit: ensureLimit(args.limit, 20, 50),
    bundlePath,
    format: normalizePortableBundleFormat(args.format),
  };
}

export async function writePortableBundle(bundlePath, portableBundle) {
  if (!bundlePath) {
    return;
  }
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, `${JSON.stringify(portableBundle, null, 2)}\n`, "utf8");
}

export function formatPortableBundleResult({ portableBundle, bundlePath, repository }) {
  return formatPortableBundleReport({
    bundleId: portableBundle.bundleId,
    signature: portableBundle.signature.digest,
    bundlePath: bundlePath ? path.relative(repoRootFromModule(), bundlePath).replaceAll(path.sep, "/") : null,
    repository,
    exportedArtifactCount: portableBundle.data.improvementArtifacts.length,
  });
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex");
}

function formatPortableBundleReport({
  bundleId,
  signature,
  bundlePath,
  repository,
  exportedArtifactCount = 0,
}) {
  return [
    "action: export",
    "format: json",
    `bundleId: ${bundleId}`,
    `signature: ${signature}`,
    `bundlePath: ${bundlePath ?? "inline"}`,
    `repository: ${repository ?? "global"}`,
    `exportedImprovementCount: ${exportedArtifactCount}`,
    "",
    "Notes:",
    "- portable bundles are local-first and review-gated",
    "- bundle includes approved improvement artifacts only",
    "- cloud/community sharing is not part of this surface",
  ].filter(Boolean).join("\n");
}

export function mapImprovementArtifactRow(row) {
  return {
    id: row.id,
    sourceCaseId: row.source_case_id,
    sourceKind: row.source_kind,
    title: row.title,
    summary: row.summary,
    status: row.status,
    reviewState: row.review_state ?? "none",
    proposal: {
      type: row.proposal_type ?? null,
      path: row.proposal_path ?? null,
      hash: row.proposal_hash ?? null,
    },
    evidence: row.evidence ?? {},
    trace: row.trace ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPortableBundle({
  repository,
  improvementArtifacts,
}) {
  const selectedArtifacts = improvementArtifacts.map(mapImprovementArtifactRow);
  const exportedAt = new Date().toISOString();
  const bundleId = `portable-${exportedAt.replace(/[:.]/g, "-")}`;
  const payload = {
    bundleVersion: PORTABLE_BUNDLE_VERSION,
    bundleType: PORTABLE_BUNDLE_TYPE,
    bundleId,
    exportedAt,
    repository: repository ?? null,
    constraints: {
      localFirst: true,
      reviewGated: true,
      autoApply: false,
    },
    data: {
      improvementArtifacts: selectedArtifacts,
    },
  };
  return {
    ...payload,
    signature: {
      algorithm: "sha256",
      digest: sha256(JSON.stringify(payload)),
    },
  };
}

function repoRootFromModule() {
  // This module lives at <repo>/lib/memory-tools-portable-bundle.mjs, so one
  // level up from its directory is the actual repository root (the Lore
  // extension is its own git repo/submodule). bundlePath is documented as
  // "repository-relative", so it must resolve against that root, not an
  // ancestor of it.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function resolveBundlePath(rawPath) {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return null;
  }
  return path.isAbsolute(trimmed)
    ? trimmed
    : path.join(repoRootFromModule(), trimmed);
}
