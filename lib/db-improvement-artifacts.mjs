import crypto from "node:crypto";

import {
  addStringFilter,
  jsonText,
  normalizeRepository,
  parseJsonArray,
  parseJsonObject,
  validateRequiredStringField,
} from "./data-utils.mjs";
import { normalizeText } from "./text-normalizer.mjs";
import { MEMORY_SCOPE } from "./memory-scope.mjs";

export const IMPROVEMENT_SOURCE_KIND = Object.freeze({
  SESSION: "session",
  SIGNAL: "signal",
  VALIDATION: "validation",
  REPLAY: "replay",
});

export const IMPROVEMENT_STATUS = Object.freeze({
  ACTIVE: "active",
  RESOLVED: "resolved",
  SUPERSEDED: "superseded",
});

export const IMPROVEMENT_REVIEW_STATE = Object.freeze({
  NONE: "none",
  DRAFT: "draft",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUPERSEDED: "superseded",
});

const SCOPE_SOURCE = Object.freeze({
  AUTO: "auto",
  MANUAL: "manual",
});

function normalizeImprovementSourceKind(value) {
  if (value === IMPROVEMENT_SOURCE_KIND.SESSION) {
    return IMPROVEMENT_SOURCE_KIND.SESSION;
  }
  if (value === IMPROVEMENT_SOURCE_KIND.SIGNAL) {
    return IMPROVEMENT_SOURCE_KIND.SIGNAL;
  }
  return value === IMPROVEMENT_SOURCE_KIND.REPLAY
    ? IMPROVEMENT_SOURCE_KIND.REPLAY
    : IMPROVEMENT_SOURCE_KIND.VALIDATION;
}

export function normalizeImprovementStatus(value, fallback = IMPROVEMENT_STATUS.ACTIVE) {
  if (value === IMPROVEMENT_STATUS.RESOLVED) {
    return IMPROVEMENT_STATUS.RESOLVED;
  }
  if (value === IMPROVEMENT_STATUS.SUPERSEDED) {
    return IMPROVEMENT_STATUS.SUPERSEDED;
  }
  return fallback;
}

function normalizeImprovementReviewState(value, fallback = IMPROVEMENT_REVIEW_STATE.NONE) {
  switch (String(value || "").trim().toLowerCase()) {
    case IMPROVEMENT_REVIEW_STATE.DRAFT:
      return IMPROVEMENT_REVIEW_STATE.DRAFT;
    case IMPROVEMENT_REVIEW_STATE.APPROVED:
      return IMPROVEMENT_REVIEW_STATE.APPROVED;
    case IMPROVEMENT_REVIEW_STATE.REJECTED:
      return IMPROVEMENT_REVIEW_STATE.REJECTED;
    case IMPROVEMENT_REVIEW_STATE.SUPERSEDED:
      return IMPROVEMENT_REVIEW_STATE.SUPERSEDED;
    case IMPROVEMENT_REVIEW_STATE.NONE:
      return IMPROVEMENT_REVIEW_STATE.NONE;
    default:
      return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseEpisodeEvidenceFields(artifact) {
  const evidence = parseJsonObject(artifact.evidence_json);
  const expectedEvidence = typeof evidence.expectedEvidence === "object"
    && evidence.expectedEvidence !== null
    && !Array.isArray(evidence.expectedEvidence)
    ? evidence.expectedEvidence
    : parseJsonObject(evidence.expectedEvidence);
  const expectedItems = Array.isArray(expectedEvidence.items)
    ? expectedEvidence.items
    : parseJsonArray(expectedEvidence.items);
  const expectedSnippets = expectedItems
    .flatMap((item) => parseJsonArray(item?.includesAny))
    .map(normalizeText)
    .filter(Boolean);
  return {
    expectedSnippets,
    rankedOutcome: normalizeText(evidence.rankingOutcome),
    missCategory: normalizeText(evidence.missCategory),
    prompt: normalizeText(evidence.prompt),
  };
}

function buildEpisodeDecisions(title, summary, rankedOutcome, missCategory, expectedSnippets) {
  return [
    title,
    summary,
    rankedOutcome ? `ranking outcome: ${rankedOutcome}` : "",
    missCategory ? `miss category: ${missCategory}` : "",
    ...expectedSnippets.slice(0, 8),
  ].map(normalizeText).filter(Boolean);
}

function buildEpisodeActions(prompt, caseId, sourceKind) {
  return [
    prompt ? `prompt: ${prompt}` : "",
    caseId ? `case: ${caseId}` : "",
    `source kind: ${normalizeText(sourceKind) || IMPROVEMENT_SOURCE_KIND.REPLAY}`,
  ].map(normalizeText).filter(Boolean);
}

export function buildImprovementArtifactFilters({
  sourceKind,
  sourceCaseId,
  status,
  reviewState,
  hasProposal,
  updatedBefore,
}) {
  const where = [];
  const params = [];

  addStringFilter(where, params, "source_kind", sourceKind, normalizeImprovementSourceKind);
  addStringFilter(where, params, "source_case_id", sourceCaseId);
  addStringFilter(where, params, "status", status, (v) => normalizeImprovementStatus(v, IMPROVEMENT_STATUS.ACTIVE));
  addStringFilter(where, params, "review_state", reviewState, normalizeImprovementReviewState);
  if (hasProposal === true) {
    where.push("proposal_path IS NOT NULL");
  } else if (hasProposal === false) {
    where.push("proposal_path IS NULL");
  }
  if (typeof updatedBefore === "string" && updatedBefore.trim().length > 0) {
    where.push("updated_at <= ?");
    params.push(updatedBefore.trim());
  }

  return { where, params };
}

export function buildImprovementArtifactEpisode(artifact, repository) {
  const { expectedSnippets, rankedOutcome, missCategory, prompt } = parseEpisodeEvidenceFields(artifact);
  const caseId = normalizeText(artifact.source_case_id);
  const summary = normalizeText(artifact.summary);
  const title = normalizeText(artifact.title);
  const updatedAt = artifact.updated_at ?? nowIso();
  const dateKey = String(updatedAt).slice(0, 10);
  const normalizedRepository = normalizeRepository(repository);
  const decisions = buildEpisodeDecisions(title, summary, rankedOutcome, missCategory, expectedSnippets);
  const actions = buildEpisodeActions(prompt, caseId, artifact.source_kind);
  return {
    id: `improvement:${artifact.id}`,
    session_id: `improvement:${caseId || artifact.id}`,
    scope: MEMORY_SCOPE.GLOBAL,
    scope_source: SCOPE_SOURCE.AUTO,
    repository: normalizedRepository,
    summary: `Replay improvement artifact: ${title}${summary ? ` — ${summary}` : ""}`,
    actions_json: jsonText(actions),
    decisions_json: jsonText(decisions),
    files_changed_json: jsonText([]),
    themes_json: jsonText([
      "replay",
      "improvement",
      caseId,
      ...expectedSnippets.slice(0, 4),
    ].map(normalizeText).filter(Boolean)),
    open_items_json: jsonText([
      `Need durable retrieval evidence for ${caseId || "replay target"}`,
    ]),
    significance: 8,
    date_key: dateKey,
    updated_at: updatedAt,
  };
}

// --- Improvement artifact operations (called by class methods) ---

export function upsertImprovementArtifactImpl(db, {
  sourceCaseId,
  sourceKind,
  title,
  summary,
  evidence = {},
  trace = {},
  linkedMemoryId = null,
}) {
  const normalizedSourceCaseId = validateRequiredStringField(sourceCaseId, "sourceCaseId");
  const normalizedTitle = validateRequiredStringField(title, "title");
  const normalizedSummary = validateRequiredStringField(summary, "summary");
  const normalizedSourceKind = normalizeImprovementSourceKind(sourceKind);
  const timestamp = nowIso();
  const activeExisting = db.prepare(`
    SELECT id
    FROM improvement_backlog
    WHERE source_case_id = ?
      AND source_kind = ?
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(normalizedSourceCaseId, normalizedSourceKind);
  if (activeExisting?.id) {
    db.prepare(`
      UPDATE improvement_backlog
      SET title = ?,
          summary = ?,
          evidence_json = ?,
          trace_json = ?,
          linked_memory_id = COALESCE(?, linked_memory_id),
          updated_at = ?
      WHERE id = ?
    `).run(
      normalizedTitle,
      normalizedSummary,
      JSON.stringify(evidence ?? {}),
      JSON.stringify(trace ?? {}),
      linkedMemoryId ?? null,
      timestamp,
      activeExisting.id,
    );
    return activeExisting.id;
  }

  const artifactId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO improvement_backlog (
      id, source_case_id, source_kind, title, summary, evidence_json, trace_json,
      status, linked_memory_id, superseded_by, created_at, updated_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL)
  `).run(
    artifactId,
    normalizedSourceCaseId,
    normalizedSourceKind,
    normalizedTitle,
    normalizedSummary,
    JSON.stringify(evidence ?? {}),
    JSON.stringify(trace ?? {}),
    linkedMemoryId ?? null,
    timestamp,
    timestamp,
  );
  return artifactId;
}

export function setImprovementArtifactProposalImpl(db, {
  id,
  proposalType,
  proposalPath,
  proposalHash,
  reviewState = IMPROVEMENT_REVIEW_STATE.DRAFT,
  reviewRequestedAt = null,
  reviewRequestedBy = null,
  reviewerDecision = null,
  reviewerNotes = {},
}) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) {
    throw new Error("id is required");
  }
  const nextReviewState = normalizeImprovementReviewState(reviewState, IMPROVEMENT_REVIEW_STATE.DRAFT);
  const timestamp = nowIso();
  db.prepare(`
    UPDATE improvement_backlog
    SET proposal_type = ?,
        proposal_path = ?,
        proposal_hash = ?,
        review_state = ?,
        review_requested_at = ?,
        review_requested_by = ?,
        reviewer_decision = ?,
        reviewer_notes_json = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    proposalType ?? null,
    proposalPath ?? null,
    proposalHash ?? null,
    nextReviewState,
    reviewRequestedAt ?? null,
    reviewRequestedBy ?? null,
    reviewerDecision ?? null,
    JSON.stringify(reviewerNotes ?? {}),
    timestamp,
    normalizedId,
  );
}

function deriveRunStatus(counts) {
  if ((counts?.pending_count ?? 0) > 0) return "running";
  if ((counts?.failed_count ?? 0) > 0) return "failed";
  return "completed";
}

function fetchLatestItemError(db, runId) {
  return db.prepare(`
      SELECT error
      FROM backfill_run_item
      WHERE run_id = ?
        AND status = 'failed'
        AND error IS NOT NULL
        AND error != ''
      ORDER BY COALESCE(processed_at, '') DESC, ordinal DESC
      LIMIT 1
    `).get(runId)?.error ?? null;
}

export function buildBackfillRunSummaryUpdateImpl(db, runId, { lastError = null } = {}) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('completed', 'skipped', 'failed') THEN 1 ELSE 0 END) AS processed_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN planned_action = 'create' AND status = 'completed' THEN 1 ELSE 0 END) AS created_episode_count,
      SUM(CASE WHEN planned_action = 'refresh' AND status = 'completed' THEN 1 ELSE 0 END) AS refreshed_episode_count,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count
    FROM backfill_run_item
    WHERE run_id = ?
  `).get(runId);

  const status = deriveRunStatus(counts);
  const derivedLastError = (typeof lastError === "string" && lastError.length > 0)
    ? lastError
    : fetchLatestItemError(db, runId);

  return {
    status,
    processedCount: counts?.processed_count ?? 0,
    createdEpisodeCount: counts?.created_episode_count ?? 0,
    refreshedEpisodeCount: counts?.refreshed_episode_count ?? 0,
    skippedCount: counts?.skipped_count ?? 0,
    failedCount: counts?.failed_count ?? 0,
    completedAt: status === "running" ? null : nowIso(),
    updatedAt: nowIso(),
    lastError: derivedLastError,
  };
}
