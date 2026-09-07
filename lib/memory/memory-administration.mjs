import path from "node:path";
import { createRecoverySnapshot } from "../maintenance/recovery.mjs";
import { inspectDatabase } from "../db/db-snapshot-lifecycle.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { normalizeText } from "../utils/content-normalizer.mjs";
import { MEMORY_SCOPE } from "./memory-scope.mjs";
import { buildRowPlan, rowKey, mutateRow, hash } from "./administration-rows.mjs";
import { buildRepairPlan, applyRepairPlan } from "./administration-repair.mjs";

const ACTIONS = new Set(["preview", "apply"]);
const OPERATIONS = new Set(["correct", "repair", "purge"]);
const SELECTOR_LIMIT = 200;
const DEFAULT_LIMIT = 50;
function normalizeIds(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > SELECTOR_LIMIT) throw new Error(`${field} cannot contain more than ${SELECTOR_LIMIT} entries`);
  if (value.some((id) => typeof id !== "string")) throw new Error(`${field} must contain strings`);
  const ids = value.map((id) => normalizeText(id)).filter(Boolean);
  if (ids.length !== value.length || new Set(ids).size !== ids.length) throw new Error(`${field} must contain unique non-empty strings`);
  return ids;
}

function normalizeMapping(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("repositoryMappings must be an array");
  if (value.length > SELECTOR_LIMIT) throw new Error(`repositoryMappings cannot contain more than ${SELECTOR_LIMIT} entries`);
  return value.map((mapping) => {
    if (!mapping || typeof mapping !== "object") throw new Error("repositoryMappings entries must be objects");
    if (typeof mapping.legacy !== "string" || typeof mapping.canonical !== "string") throw new Error("repositoryMappings requires string identities");
    const legacy = normalizeRepository(mapping.legacy);
    const canonical = normalizeRepository(mapping.canonical);
    if (!legacy || !canonical) throw new Error("repositoryMappings requires legacy and canonical identities");
    if (legacy === canonical) throw new Error("repositoryMappings cannot map an identity to itself");
    return { legacy, canonical };
  });
}

export function normalizeAdministrationRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("administration request must be an object");
  if (input.operation !== undefined && typeof input.operation !== "string") throw new Error("operation must be a string");
  const operation = normalizeText(input.operation ?? input.command ?? input.tool)?.toLowerCase();
  if (!OPERATIONS.has(operation)) throw new Error("operation must be one of correct, repair, purge");
  if (input.action !== undefined && typeof input.action !== "string") throw new Error("action must be a string");
  const action = input.action === undefined ? "preview" : normalizeText(input.action).toLowerCase();
  if (!ACTIONS.has(action)) throw new Error("action must be preview or apply");
  const memoryIds = normalizeIds(input.memoryIds ?? (input.memoryId ? [input.memoryId] : undefined), "memoryIds");
  const sessionIds = normalizeIds(input.sessionIds ?? (input.sessionId ? [input.sessionId] : undefined), "sessionIds");
  if (input.repository !== undefined && input.repository !== null && typeof input.repository !== "string") throw new Error("repository must be a string");
  const repository = input.repository === undefined || input.repository === null ? null : normalizeRepository(input.repository);
  if (input.repository !== undefined && input.repository !== null && !repository) throw new Error("repository must be a non-empty normalized identity");
  const repositoryMappings = normalizeMapping(input.repositoryMappings);
  if (input.scope !== undefined && input.scope !== null && typeof input.scope !== "string") throw new Error("scope must be a string");
  const scope = input.scope === undefined || input.scope === null ? null : normalizeText(input.scope).toLowerCase();
  if (scope !== null && !Object.values(MEMORY_SCOPE).includes(scope)) throw new Error("scope must be global, transferable, or repo");
  if (scope && operation !== "correct" && scope !== MEMORY_SCOPE.GLOBAL) throw new Error("scope is only a global purge selector for this operation");
  if (input.type !== undefined && (typeof input.type !== "string" || !normalizeText(input.type))) throw new Error("type must be a non-empty string");
  if (input.includeDependentAggregates !== undefined && typeof input.includeDependentAggregates !== "boolean") throw new Error("includeDependentAggregates must be a boolean");
  if (operation !== "repair" && repositoryMappings.length) throw new Error("repositoryMappings is only supported by repair");
  if (operation === "repair" && scope !== null) throw new Error("repair does not accept a scope selector");
  const globalSelection = scope === MEMORY_SCOPE.GLOBAL && operation === "purge";
  const selectorCount = Number(memoryIds.length > 0) + Number(sessionIds.length > 0) + Number(Boolean(repository)) + Number(repositoryMappings.length > 0) + Number(globalSelection);
  if (operation === "correct" && memoryIds.length !== 1) throw new Error("correct requires exactly one memoryId");
  if (operation === "correct" && (sessionIds.length > 0 || repositoryMappings.length > 0)) throw new Error("correct accepts only memoryId and optional replacement repository");
  if (operation !== "correct" && selectorCount === 0) throw new Error("an explicit selector is required");
  if (operation === "purge" && memoryIds.length > 0 && (sessionIds.length > 0 || repository || repositoryMappings.length > 0 || globalSelection)) {
    throw new Error("purge memoryIds cannot be combined with another selector");
  }
  if (operation === "purge" && sessionIds.length > 0) throw new Error("purge requires memoryIds, repository, or explicit global scope");
  if (operation === "repair" && memoryIds.length > 0 && sessionIds.length > 0) throw new Error("repair memoryIds and sessionIds are mutually exclusive");
  if (operation === "repair" && repositoryMappings.length > 0 && (memoryIds.length > 0 || sessionIds.length > 0 || repository)) throw new Error("repair repositoryMappings cannot be combined with another selector");
  if (operation === "purge" && globalSelection && (repository || sessionIds.length > 0 || repositoryMappings.length > 0)) throw new Error("global purge cannot be combined with another selector");
  if (operation === "purge" && repository === "global") throw new Error("global purge requires explicit scope global");
  const limit = input.limit === undefined ? DEFAULT_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > SELECTOR_LIMIT) throw new Error(`limit must be between 1 and ${SELECTOR_LIMIT}`);
  if (input.content !== undefined && typeof input.content !== "string") throw new Error("content must be a string");
  if (input.reason !== undefined && typeof input.reason !== "string") throw new Error("reason must be a string");
  const content = input.content === undefined ? undefined : normalizeText(input.content);
  if (operation === "correct" && content === "") throw new Error("content must be non-empty");
  if (operation === "correct" && input.reason !== undefined && !normalizeText(input.reason)) throw new Error("reason must be non-empty");
  const selectedCandidateIds = normalizeIds(input.selectedCandidateIds, "selectedCandidateIds");
  if (operation === "repair" && action === "apply" && selectedCandidateIds.length === 0) throw new Error("repair apply requires explicit selectedCandidateIds");
  if (operation === "purge" && action === "apply" && input.includeDependentAggregates === true && selectedCandidateIds.length === 0) throw new Error("purge aggregate deletion requires explicit selectedCandidateIds from preview");
  if (input.expiresAt !== undefined && input.expiresAt !== null && (typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt)))) throw new Error("expiresAt must be a valid timestamp or null");
  if (new Set(repositoryMappings.map((mapping) => mapping.legacy)).size !== repositoryMappings.length || repositoryMappings.some((mapping) => repositoryMappings.some((other) => other.legacy === mapping.canonical))) throw new Error("repositoryMappings must be unique and cannot form chains");
  return Object.freeze({
    operation,
    action,
    memoryIds,
    sessionIds,
    repository,
    repositoryMappings,
    scope,
    content,
    type: input.type === undefined ? undefined : normalizeText(input.type),
    reason: input.reason === undefined ? "explicit administration" : normalizeText(input.reason),
    includeDependentAggregates: input.includeDependentAggregates === true,
    selectedCandidateIds,
    expiresAt: input.expiresAt,
    limit,
  });
}

function replacementFor(old, request) {
  const scope = request.scope ?? old.scope;
  const repository = scope === "global" ? null : request.repository ?? old.repository;
  if (scope !== "global" && !repository) throw new Error("replacement scope requires a repository");
  return { type: request.type ?? old.type, content: request.content ?? old.content, scope, repository, expiresAt: request.expiresAt === undefined ? old.expires_at : request.expiresAt };
}

function makePlan(owner, input) {
  const request = normalizeAdministrationRequest({ ...input, action: "preview" });
  owner.ensureOpen();
  const rows = buildRowPlan(owner.db, request);
  const repair = request.operation === "repair" && !rows.unresolved.some((item) => item.code === "BOUND_REACHED") ? buildRepairPlan(owner, request, rows) : { candidates: [], sources: [], unresolved: [] };
  const { action: _action, selectedCandidateIds: _selection, ...stable } = request;
  const replacement = request.operation === "correct" && rows.memories[0] ? replacementFor(rows.memories[0], request) : null;
  const replacementKey = replacement ? owner.buildSemanticMemoryWriteContext({ ...replacement, metadata: { source: "memory_save" } }, "2026-01-01T00:00:00Z").canonicalKey : null;
  const destination = replacement ? owner.db.prepare("SELECT * FROM semantic_memory WHERE type=? AND scope=? AND repository IS ? AND ((? IS NOT NULL AND canonical_key=?) OR content=?) ORDER BY id LIMIT ?").all(replacement.type, replacement.scope, replacement.repository, replacementKey, replacementKey, replacement.content, request.limit + 1) : [];
  const suppressionClauses = [], suppressionArgs = [];
  if (rows.memories.length) {
    suppressionClauses.push(`memory_id IN (${rows.memories.map(() => "?").join(",")})`);
    suppressionArgs.push(...rows.memories.map((row) => row.id));
  }
  const suppressionKeys = new Set(repair.suppressionKeys ?? []);
  if (replacement) {
    const match = owner.findActiveSuppression(owner.buildSemanticMemoryWriteContext({ ...replacement, metadata: { source: "memory_save" } }, "2026-01-01T00:00:00Z"));
    if (match) suppressionKeys.add(match.suppression_key);
  }
  if (suppressionKeys.size) {
    suppressionClauses.push(`suppression_key IN (${[...suppressionKeys].map(() => "?").join(",")})`);
    suppressionArgs.push(...suppressionKeys);
  }
  // Mapping suppression rows are already included in the exact mapping table
  // plan. Other commands hash only lifecycle state that can change their action.
  const suppression = suppressionClauses.length ? owner.db.prepare(`SELECT * FROM memory_suppression WHERE ${suppressionClauses.join(" OR ")} ORDER BY suppression_key LIMIT ?`).all(...suppressionArgs, request.limit + 1) : [];
  if (suppression.length > request.limit || destination.length > request.limit) rows.unresolved.push({ code: "BOUND_REACHED", detail: "Related lifecycle state exceeds the preview limit." });
  const mappings = owner.getRepositoryMappings();
  const affectedStateFingerprint = hash({ tables: rows.tables, mappingRows: rows.mappings, suppression, mappings, sources: repair.sources, repair: repair.candidates, destination });
  const affected = {
    memoryIds: rows.memories.map((row) => row.id), sessionIds: rows.sessions,
    repairDestinationMemoryIds: [...new Set(repair.candidates.flatMap((candidate) => candidate.destinationRows.map((row) => row.id)))],
    episodeIds: (rows.tables.episode_digest ?? []).map((row) => row.id),
    evidenceKeys: (rows.tables.session_evidence ?? []).map((row) => row.evidence_key),
    daySummaryKeys: (rows.tables.day_summary ?? []).map((row) => JSON.stringify([row.date_key, row.repository])),
    checkpointKeys: (rows.tables.ingestion_checkpoint ?? []).map((row) => `${row.client}:${row.session_id}`),
  };
  for (const [table, items] of Object.entries(rows.tables)) affected[table] = items.map((row) => rowKey(owner.db, table, row));
  const candidateIds = request.operation === "repair" ? [...rows.mappings.map((row) => row.candidateId), ...repair.candidates.map((row) => row.candidateId)] : rows.aggregates.map((row) => row.candidateId);
  const unresolvedCandidates = [...rows.unresolved, ...repair.unresolved];
  if (candidateIds.length > SELECTOR_LIMIT) unresolvedCandidates.push({ code: "BOUND_REACHED", detail: "Too many dependent candidates; narrow the selector." });
  const report = {
    action: "preview", operation: request.operation,
    selectors: { memoryIds: request.memoryIds, sessionIds: request.sessionIds, repository: request.repository, repositoryMappings: request.repositoryMappings },
    affected, affectedCount: Object.fromEntries(Object.entries(affected).map(([key, values]) => [key, values.length])),
    unresolvedCandidates, candidateIds, aggregateCandidates: rows.aggregates,
    repairCandidates: repair.candidates.map((candidate) => ({ ...candidate, proposed: candidate.memories.map(({ type, content, scope, repository }) => ({ type, content, scope, repository })) })),
    sourceHashes: repair.sources,
    source: (rows.tables.ingestion_checkpoint ?? []).map((row) => ({ client: row.client, sessionId: row.session_id, sourceIdentity: row.source_identity, available: repair.sources.some((source) => source.sessionId === row.session_id) })),
    planFingerprint: hash({ request: stable, affectedStateFingerprint }), affectedStateFingerprint,
    backup: { plannedPath: path.join(owner.config.paths.backupDir, "lore-<apply-timestamp>.db"), created: false }, integrity: "not_checked",
    retention: { rawSources: "retained", existingBackups: "retained", snapshot: "planned_before_mutation", secureErasure: false, suppression: "minimal_non_plaintext_suppression_retained" },
  };
  if (replacement) { report.old = { ...rows.memories[0], evidenceKeys: affected.evidenceKeys }; report.replacement = replacement; }
  return { request, rows, repair, report };
}

export function previewMemoryAdministration(owner, input) { return makePlan(owner, input).report; }

function correct(owner, plan) {
  const old = plan.rows.memories[0];
  // Remove the old row from canonical matching, then use the explicit lifecycle
  // facade to create/update a manual destination and its existing canonical row.
  owner.forgetMemory({ id: old.id, actor: "memory_correct", reason: plan.request.reason });
  const replacementId = owner.insertSemanticMemory({ ...plan.report.replacement, confidence: old.confidence,
    sourceSessionId: old.source_session_id, sourceTurnIndex: old.source_turn_index, domainKey: old.domain_key,
    tags: ["manual", "correction"], metadata: { source: "memory_save", correctionOf: old.id, correctionReason: plan.request.reason, correctionProvenance: { kind: "memory_correct", sourceMemoryId: old.id } } });
  owner.db.prepare("UPDATE semantic_memory SET scope_source='manual' WHERE id=?").run(replacementId);
  owner.db.prepare("UPDATE semantic_memory SET superseded_by=? WHERE id=?").run(replacementId, old.id);
  return replacementId;
}

function purge(owner, plan, selected) {
  for (const row of plan.rows.memories) owner.forgetMemory({ id: row.id, actor: "memory_purge", reason: "explicit_purge" });
  for (const table of ["memory_embedding", "memory_evidence", "scope_override_audit", "semantic_memory"]) for (const row of plan.rows.tables[table] ?? []) mutateRow(owner.db, table, rowKey(owner.db, table, row));
  for (const row of plan.rows.tables.session_evidence ?? []) {
    if (!owner.db.prepare("SELECT 1 FROM memory_evidence WHERE evidence_key=? LIMIT 1").get(row.evidence_key)) mutateRow(owner.db, "session_evidence", { evidence_key: row.evidence_key });
  }
  for (const candidate of plan.rows.aggregates) if (selected.has(candidate.candidateId)) mutateRow(owner.db, candidate.table, candidate.key);
}

export function applyMemoryAdministration(owner, input, planFingerprint = input?.planFingerprint) {
  const request = normalizeAdministrationRequest({ ...input, action: "apply" });
  const plan = makePlan(owner, request);
  if (plan.report.planFingerprint !== planFingerprint) throw new Error("administration plan fingerprint is stale; preview again");
  if (plan.report.unresolvedCandidates.length) throw new Error(`administration target is unresolved: ${plan.report.unresolvedCandidates.map((item) => item.code).join(", ")}`);
  const selected = new Set(request.selectedCandidateIds);
  if (request.selectedCandidateIds.some((id) => !plan.report.candidateIds.includes(id))) throw new Error("selectedCandidateIds must be actionable IDs from preview");
  if (request.operation === "purge" && plan.rows.aggregates.some((row) => !selected.has(row.candidateId))) throw new Error("select all previewed dependent aggregates or narrow the purge selector");
  if (request.operation === "repair" && !plan.report.candidateIds.length) throw new Error("no actionable repair candidates");
  let snapshot;
  try { snapshot = createRecoverySnapshot({ derivedStorePath: owner.config.paths.derivedStorePath, backupDir: owner.config.paths.backupDir }); }
  catch { throw new Error("administration snapshot failed; no writes were made"); }
  let replacementId = null;
  let repairedMemoryIds = [];
  owner.withSemanticMemoryTransaction(() => {
    const fresh = makePlan(owner, request);
    if (fresh.report.unresolvedCandidates.length || fresh.report.planFingerprint !== plan.report.planFingerprint) throw new Error("administration plan fingerprint changed after snapshot; no writes were made");
    if (request.operation === "correct") replacementId = correct(owner, plan);
    if (request.operation === "purge") purge(owner, plan, selected);
    if (request.operation === "repair") {
      repairedMemoryIds = applyRepairPlan(owner, plan.repair.candidates, selected);
      for (const mapping of plan.rows.mappings) if (selected.has(mapping.candidateId)) {
        for (const change of mapping.changes) mutateRow(owner.db, change.table, change.key, change.updates);
        owner.setRepositoryMapping({ legacy: mapping.legacy, canonical: mapping.canonical });
      }
    }
  });
  let integrity = "ok";
  try { if (inspectDatabase(owner.config.paths.derivedStorePath).integrity !== "ok") integrity = "applied_with_verification_failure"; }
  catch { integrity = "applied_with_verification_failure"; }
  const result = { ...plan.report, action: "apply", backup: { ...snapshot, created: true }, integrity, applied: true };
  if (request.operation === "repair") { result.repairedMemoryIds = repairedMemoryIds; result.affected.generatedMemoryIds = repairedMemoryIds; result.affectedCount.generatedMemoryIds = repairedMemoryIds.length; }
  if (replacementId) { result.replacementId = replacementId; result.replacement = owner.db.prepare("SELECT * FROM semantic_memory WHERE id=?").get(replacementId); }
  return result;
}

const bindPreview = (operation) => (db, request) => previewMemoryAdministration(db, { ...request, operation });
const bindApply = (operation) => (db, request, fingerprint) => applyMemoryAdministration(db, { ...request, operation }, fingerprint ?? request?.planFingerprint);
export const previewMemoryCorrection = bindPreview("correct");
export const previewMemoryRepair = bindPreview("repair");
export const previewMemoryPurge = bindPreview("purge");
export const applyMemoryCorrection = bindApply("correct");
export const applyMemoryRepair = bindApply("repair");
export const applyMemoryPurge = bindApply("purge");
export const memoryCorrect = (db, request) => request?.action === "apply" ? applyMemoryCorrection(db, request) : previewMemoryCorrection(db, request);
export const memoryRepair = (db, request) => request?.action === "apply" ? applyMemoryRepair(db, request) : previewMemoryRepair(db, request);
export const memoryPurge = (db, request) => request?.action === "apply" ? applyMemoryPurge(db, request) : previewMemoryPurge(db, request);
