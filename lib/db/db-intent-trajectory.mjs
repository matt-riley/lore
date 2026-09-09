import crypto from "node:crypto";
import { parseJsonObject } from "../utils/json-object-utils.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { addStringFilter } from "../utils/sql-filter-utils.mjs";
import { validateRequiredStringField } from "../utils/required-field-utils.mjs";
import { nowIso } from "./db-shared.mjs";

export function insertIntentJournalEntry(owner, {
  repository = null,
  sessionId = null,
  turnHint = null,
  intentKind = "journal",
  summary,
  rationale = null,
  context = {},
}) {
  owner.ensureOpen();
  const normalizedSummary = String(summary || "").trim();
  if (!normalizedSummary) {
    throw new Error("summary is required");
  }
  const normalizeIntentKind = (value) => {
    const normalized = String(value || "").trim().toLowerCase() || "journal";
    const allowedKinds = new Set(["journal", "routing", "rollout", "reviewer", "fallback", "serendipity"]);
    return allowedKinds.has(normalized) ? normalized : "journal";
  };
  const normalizeOptionalString = (value) => (
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null
  );
  const id = crypto.randomUUID();
  owner.db.prepare(`
    INSERT INTO intent_journal (
      id,
      repository,
      session_id,
      turn_hint,
      intent_kind,
      summary,
      rationale,
      context_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    normalizeRepository(repository),
    normalizeOptionalString(sessionId),
    normalizeOptionalString(turnHint),
    normalizeIntentKind(intentKind),
    normalizedSummary,
    normalizeOptionalString(rationale),
    JSON.stringify(context ?? {}),
    nowIso(),
  );
  return id;
}

export function listIntentJournalEntries(owner, {
  repository,
  sessionId,
  intentKind,
  limit = 10,
} = {}) {
  owner.ensureOpen();
  const where = [];
  const params = [];
  addStringFilter(where, params, "repository", repository);
  addStringFilter(where, params, "session_id", sessionId);
  addStringFilter(where, params, "intent_kind", intentKind, (v) => v.toLowerCase());
  params.push(limit);
  const rows = owner.db.prepare(`
    SELECT
      id,
      repository,
      session_id,
      turn_hint,
      intent_kind,
      summary,
      rationale,
      context_json,
      created_at
    FROM intent_journal
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params);
  return rows.map((row) => ({
    ...row,
    context: parseJsonObject(row.context_json),
  }));
}

export function insertTrajectoryArtifact(owner, {
  kind,
  repository = null,
  sourceCaseId = null,
  sourceKind = null,
  improvementArtifactId = null,
  eventKey = null,
  summary,
  severity = "info",
  outcome = "captured",
  latencyMs = null,
  targetMs = null,
  context = {},
  trace = {},
}) {
  owner.ensureOpen();
  const normalizedKind = validateRequiredStringField(kind, "kind");
  const normalizedSummary = validateRequiredStringField(summary, "summary");
  const normalizeOptionalValue = (value) => (value ? String(value) : null);
  const roundIfFinite = (value) => (Number.isFinite(value) ? Math.round(value) : null);
  const id = crypto.randomUUID();
  owner.db.prepare(`
    INSERT INTO trajectory_artifact (
      id,
      kind,
      repository,
      source_case_id,
      source_kind,
      improvement_artifact_id,
      event_key,
      summary,
      severity,
      outcome,
      latency_ms,
      target_ms,
      context_json,
      trace_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    normalizedKind,
    normalizeRepository(repository),
    normalizeOptionalValue(sourceCaseId),
    normalizeOptionalValue(sourceKind),
    normalizeOptionalValue(improvementArtifactId),
    normalizeOptionalValue(eventKey),
    normalizedSummary,
    String(severity || "info"),
    String(outcome || "captured"),
    roundIfFinite(latencyMs),
    roundIfFinite(targetMs),
    JSON.stringify(context ?? {}),
    JSON.stringify(trace ?? {}),
    nowIso(),
  );
  return id;
}

export function listTrajectoryArtifacts(owner, {
  kind,
  sourceKind,
  sourceCaseId,
  repository,
  limit = 10,
} = {}) {
  owner.ensureOpen();
  const where = [];
  const params = [];
  addStringFilter(where, params, "kind", kind);
  addStringFilter(where, params, "source_kind", sourceKind);
  addStringFilter(where, params, "source_case_id", sourceCaseId);
  addStringFilter(where, params, "repository", repository);
  params.push(limit);
  const rows = owner.db.prepare(`
    SELECT
      id,
      kind,
      repository,
      source_case_id,
      source_kind,
      improvement_artifact_id,
      event_key,
      summary,
      severity,
      outcome,
      latency_ms,
      target_ms,
      context_json,
      trace_json,
      created_at
    FROM trajectory_artifact
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params);
  return rows.map((row) => ({
    ...row,
    context: parseJsonObject(row.context_json),
    trace: parseJsonObject(row.trace_json),
  }));
}
