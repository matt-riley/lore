/**
 * extraction-revalidation.mjs
 *
 * Orchestrates lib/sessions/extraction-revalidation.mjs's pure grammar replay
 * against stored generated semantic memories: query candidates, apply
 * verdicts (reject / reclassify / demote) behind a reversible
 * `extractor-revalidation:<runId>` marker, and roll a run back. Report-only
 * by default -- mirrors runMemoryHygiene's shadow/apply split in
 * lib/memory/memory-hygiene.mjs, but never writes a memory_suppression row:
 * a rejected row here means "the current grammar would not produce this",
 * not "the user asked to forget this".
 */
import crypto from "node:crypto";
import {
  EXTRACTOR_VERSION,
  revalidateGeneratedMemory,
} from "../sessions/extraction-revalidation.mjs";

function buildMarker(runId) {
  return `extractor-revalidation:${runId}`;
}

function buildItemArtifact({ candidate, evaluation, mode, marker }) {
  return {
    kind: "extraction_revalidation",
    repository: candidate.repository ?? null,
    sourceCaseId: candidate.id,
    sourceKind: candidate.type,
    eventKey: `${marker}:${candidate.id}`,
    summary: `${candidate.type} ${candidate.id}: ${evaluation.reason}`,
    severity: evaluation.verdict === "keep" ? "info" : "warning",
    outcome: mode === "apply" && evaluation.verdict !== "keep" ? "applied" : evaluation.verdict,
    context: {
      marker,
      mode,
      memoryId: candidate.id,
      memoryType: candidate.type,
      memoryScope: candidate.scope,
      verdict: evaluation.verdict,
      reason: evaluation.reason,
      reclassifiedType: evaluation.reclassifiedType ?? null,
      targetScope: evaluation.targetScope ?? null,
      targetRepository: evaluation.targetRepository ?? null,
    },
  };
}

function applyVerdict({ db, candidate, evaluation, marker, actor, reason }) {
  if (evaluation.verdict === "reject") {
    return db.supersedeExtractionRevalidationMemory({ id: candidate.id, marker });
  }
  if (evaluation.verdict === "reclassify") {
    return db.reclassifyExtractionRevalidationMemory({
      id: candidate.id,
      previousType: candidate.type,
      nextType: evaluation.reclassifiedType,
      extractorVersion: EXTRACTOR_VERSION,
      marker,
      actor,
      reason,
    });
  }
  if (evaluation.verdict === "demote") {
    db.demoteExtractionRevalidationMemory({
      id: candidate.id,
      targetRepository: evaluation.targetRepository,
      marker,
      actor,
      reason,
    });
    return true;
  }
  return false;
}

/**
 * Report-only unless mode is "apply". Bounded by maxItems per run.
 */
export function runExtractionRevalidation({
  db,
  repository = null,
  mode = "shadow",
  maxItems = 50,
  includeGlobal = true,
  runId = crypto.randomUUID(),
  actor = "extractor_revalidation",
  reason = null,
} = {}) {
  if (!db) {
    throw new Error("db is required");
  }
  if (!["shadow", "apply"].includes(mode)) {
    throw new Error(`unsupported extraction revalidation mode: ${mode}`);
  }

  const marker = buildMarker(runId);
  const effectiveReason = reason ?? marker;
  const candidates = db.listExtractionRevalidationCandidates({
    repository,
    includeGlobal,
    limit: maxItems,
    extractorVersion: EXTRACTOR_VERSION,
  });

  const items = [];
  for (const candidate of candidates) {
    const evaluation = revalidateGeneratedMemory(candidate);
    if (mode === "apply" && evaluation.verdict !== "keep") {
      applyVerdict({ db, candidate, evaluation, marker, actor, reason: effectiveReason });
    }
    db.insertTrajectoryArtifact(buildItemArtifact({ candidate, evaluation, mode, marker }));
    items.push({
      memoryId: candidate.id,
      memoryType: candidate.type,
      scope: candidate.scope,
      repository: candidate.repository,
      content: candidate.content,
      ...evaluation,
    });
  }

  const summary = {
    runId,
    marker,
    mode,
    extractorVersion: EXTRACTOR_VERSION,
    inspectedCount: items.length,
    keepCount: items.filter((item) => item.verdict === "keep").length,
    rejectCount: items.filter((item) => item.verdict === "reject").length,
    reclassifyCount: items.filter((item) => item.verdict === "reclassify").length,
    demoteCount: items.filter((item) => item.verdict === "demote").length,
    appliedCount: mode === "apply" ? items.filter((item) => item.verdict !== "keep").length : 0,
    items,
  };

  const summaryArtifactId = db.insertTrajectoryArtifact({
    kind: "extraction_revalidation_run",
    repository: repository ?? null,
    sourceKind: "maintenance",
    eventKey: marker,
    summary: `Extraction revalidation ${mode}: ${summary.rejectCount} reject, ${summary.reclassifyCount} reclassify, `
      + `${summary.demoteCount} demote, ${summary.keepCount} kept`,
    severity: "info",
    outcome: mode === "apply" ? "completed" : "reported",
    context: {
      marker,
      mode,
      extractorVersion: EXTRACTOR_VERSION,
      inspectedCount: summary.inspectedCount,
      rejectCount: summary.rejectCount,
      reclassifyCount: summary.reclassifyCount,
      demoteCount: summary.demoteCount,
      appliedCount: summary.appliedCount,
      sampleItems: items.slice(0, 10).map((item) => ({
        memoryId: item.memoryId,
        memoryType: item.memoryType,
        scope: item.scope,
        content: item.content,
        verdict: item.verdict,
        reason: item.reason,
      })),
    },
  });

  return { ...summary, summaryArtifactId };
}

export function rollbackExtractionRevalidation({
  db,
  marker,
  actor,
  reason,
} = {}) {
  if (!db) {
    throw new Error("db is required");
  }
  const result = db.rollbackExtractionRevalidation({ marker, actor, reason });
  const artifactId = db.insertTrajectoryArtifact({
    kind: "extraction_revalidation_rollback",
    sourceKind: "operator",
    eventKey: `rollback:${result.marker}`,
    summary: `Restored ${result.restoredRejectedIds.length} rejected and ${result.restoredOverrideIds.length} `
      + "reclassified/demoted extraction-revalidation rows",
    severity: "warning",
    outcome: "restored",
    context: {
      marker: result.marker,
      actor: String(actor ?? "") || "unknown",
      reason: String(reason ?? "") || "unspecified",
      restoredRejectedIds: result.restoredRejectedIds,
      restoredOverrideIds: result.restoredOverrideIds,
    },
  });
  return {
    artifactId,
    marker: result.marker,
    restoredRejectedIds: result.restoredRejectedIds,
    restoredOverrideIds: result.restoredOverrideIds,
  };
}
