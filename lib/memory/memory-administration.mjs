import crypto from "node:crypto";
import path from "node:path";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { createRecoverySnapshot } from "../maintenance/recovery.mjs";
import { inspectDatabase } from "../db/db-snapshot-lifecycle.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { normalizeText } from "../utils/content-normalizer.mjs";
import { buildSemanticCanonicalKey, MEMORY_SCOPE } from "./memory-scope.mjs";
import { parseCliTranscript } from "../clients/cli-session-reader.mjs";
import { extractSessionMemories } from "../sessions/rule-extractor.mjs";
import { normalizeEvidence } from "../db/db-memory-lifecycle.mjs";

const ACTIONS = new Set(["preview", "apply"]);
const OPERATIONS = new Set(["correct", "repair", "purge"]);
const SELECTOR_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const DERIVED_REPOSITORY_TABLES = Object.freeze([
  ["semantic_memory", "repository"],
  ["episode_digest", "repository"],
  ["day_summary", "repository"],
  ["memory_domain", "repository"],
  ["refreshable_observation", "repository"],
  ["deferred_extraction", "repository"],
  ["improvement_backlog", "repository"],
  ["trajectory_artifact", "repository"],
  ["intent_journal", "repository"],
  ["backfill_run", "repository"],
  ["retrieval_trace_sample", "repository"],
  ["lore_activity_state", "repository"],
  ["session_evidence", "repository"],
  ["ingestion_checkpoint", "repository"],
]);

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(table));
}

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
  if (input.type !== undefined && typeof input.type !== "string") throw new Error("type must be a string");
  const globalSelection = scope === MEMORY_SCOPE.GLOBAL && operation === "purge";
  const selectorCount = Number(memoryIds.length > 0) + Number(sessionIds.length > 0) + Number(Boolean(repository)) + Number(repositoryMappings.length > 0) + Number(globalSelection);
  if (operation === "correct" && memoryIds.length !== 1) throw new Error("correct requires exactly one memoryId");
  if (operation === "correct" && (sessionIds.length > 0 || repositoryMappings.length > 0)) throw new Error("correct accepts only memoryId and optional repository constraint");
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
    limit,
  });
}

function rowsForIds(db, ids) {
  if (ids.length === 0) return [];
  return db.prepare(`SELECT * FROM semantic_memory WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).all(...ids);
}

function rowsForSessions(db, ids) {
  if (ids.length === 0 || !tableExists(db, "episode_digest")) return [];
  return db.prepare(`SELECT * FROM episode_digest WHERE session_id IN (${ids.map(() => "?").join(",")}) ORDER BY session_id`).all(...ids);
}

function selectedMemories(db, request) {
  if (request.memoryIds.length > 0) return rowsForIds(db, request.memoryIds);
  if (request.sessionIds.length > 0) {
    if (!tableExists(db, "session_evidence")) return [];
    return db.prepare(`
      SELECT DISTINCT sm.* FROM semantic_memory sm
      JOIN memory_evidence me ON me.memory_id = sm.id
      JOIN session_evidence se ON se.evidence_key = me.evidence_key
      WHERE se.session_id IN (${request.sessionIds.map(() => "?").join(",")})
      ORDER BY sm.id
    `).all(...request.sessionIds);
  }
  if (request.repository && request.operation === "purge") {
    return db.prepare("SELECT * FROM semantic_memory WHERE repository = ? ORDER BY id LIMIT ?").all(request.repository, request.limit);
  }
  if (request.operation === "purge" && request.scope === MEMORY_SCOPE.GLOBAL) {
    return db.prepare("SELECT * FROM semantic_memory WHERE scope = 'global' ORDER BY id LIMIT ?").all(request.limit);
  }
  return [];
}

function rowsForRepository(db, table, column, repository, limit) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY rowid LIMIT ?`).all(repository, limit);
}

function allAffectedRows(db, request, memories) {
  const sessions = new Set(request.sessionIds);
  for (const memory of memories) if (memory.source_session_id) sessions.add(memory.source_session_id);
  const evidence = tableExists(db, "memory_evidence") && memories.length > 0
    ? db.prepare(`SELECT me.*, se.session_id, se.repository, se.evidence_key, se.content_hash, se.proposition_fingerprint FROM memory_evidence me JOIN session_evidence se ON se.evidence_key = me.evidence_key WHERE me.memory_id IN (${memories.map(() => "?").join(",")})`).all(...memories.map((row) => row.id))
    : [];
  for (const row of evidence) if (row.session_id) sessions.add(row.session_id);
  const episodes = sessions.size > 0 ? rowsForSessions(db, [...sessions]) : [];
  const checkpoints = tableExists(db, "ingestion_checkpoint") && sessions.size > 0
    ? db.prepare(`SELECT * FROM ingestion_checkpoint WHERE session_id IN (${[...sessions].map(() => "?").join(",")}) ORDER BY client, session_id`).all(...sessions)
    : [];
  const daySummaries = [];
  if (tableExists(db, "day_summary") && episodes.length > 0) {
    for (const episode of episodes) {
      const rows = db.prepare("SELECT * FROM day_summary WHERE date_key = ? AND repository = ?").all(episode.date_key, episode.repository ?? "");
      daySummaries.push(...rows);
    }
  }
  const domainKeys = [...new Set(memories.map((row) => row.domain_key).filter(Boolean))];
  const dependent = {
    domains: domainKeys.length > 0 && tableExists(db, "memory_domain")
      ? db.prepare(`SELECT * FROM memory_domain WHERE domain_key IN (${domainKeys.map(() => "?").join(",")})`).all(...domainKeys)
      : [],
    observations: domainKeys.length > 0 && tableExists(db, "refreshable_observation")
      ? db.prepare(`SELECT * FROM refreshable_observation WHERE domain_key IN (${domainKeys.map(() => "?").join(",")})`).all(...domainKeys)
      : [],
    improvements: tableExists(db, "improvement_backlog") && memories.length > 0
      ? db.prepare(`SELECT * FROM improvement_backlog WHERE linked_memory_id IN (${memories.map(() => "?").join(",")})`).all(...memories.map((row) => row.id))
      : [],
    scopeAudits: tableExists(db, "scope_override_audit") && memories.length > 0
      ? db.prepare(`SELECT * FROM scope_override_audit WHERE target_type = 'semantic' AND target_id IN (${memories.map(() => "?").join(",")})`).all(...memories.map((row) => row.id))
      : [],
    backfillItems: tableExists(db, "backfill_run_item") && sessions.size > 0
      ? db.prepare(`SELECT * FROM backfill_run_item WHERE session_id IN (${[...sessions].map(() => "?").join(",")})`).all(...sessions)
      : [],
    intents: tableExists(db, "intent_journal") && sessions.size > 0
      ? db.prepare(`SELECT * FROM intent_journal WHERE session_id IN (${[...sessions].map(() => "?").join(",")})`).all(...sessions)
      : [],
    trajectories: [],
    retrievalTraces: [],
  };
  const provenanceIds = [...sessions, ...memories.map((row) => row.id)];
  if (tableExists(db, "trajectory_artifact") && provenanceIds.length > 0) {
    const clauses = provenanceIds.map(() => "source_case_id = ? OR context_json LIKE ?").join(" OR ");
    const args = provenanceIds.flatMap((id) => [id, `%${id}%`]);
    dependent.trajectories = db.prepare(`SELECT * FROM trajectory_artifact WHERE ${clauses}`).all(...args);
  }
  if (tableExists(db, "retrieval_trace_sample") && provenanceIds.length > 0) {
    const clauses = provenanceIds.map(() => "lookups_json LIKE ? OR trace_json LIKE ? OR output_json LIKE ?").join(" OR ");
    const args = provenanceIds.flatMap((id) => [`%${id}%`, `%${id}%`, `%${id}%`]);
    dependent.retrievalTraces = db.prepare(`SELECT * FROM retrieval_trace_sample WHERE ${clauses}`).all(...args);
  }
  return { memories, evidence, episodes, daySummaries, checkpoints, sessions: [...sessions], dependent };
}

function collectRepositoryDependencies(db, repository, limit) {
  const result = {};
  for (const [table, column] of DERIVED_REPOSITORY_TABLES) result[table] = rowsForRepository(db, table, column, repository, limit);
  if (tableExists(db, "scope_override_audit")) result.scope_override_audit = db.prepare("SELECT * FROM scope_override_audit WHERE previous_repository = ? OR next_repository = ? ORDER BY created_at LIMIT ?").all(repository, repository, limit);
  return result;
}

function fingerprintState(db, request, dependencies, repair = { sourceHashes: [], candidates: [] }) {
  const state = {
    selectors: request,
    memories: dependencies.memories.map((row) => [row.id, row.updated_at, row.content, row.superseded_by, row.canonical_key, row.scope, row.repository]),
    evidence: dependencies.evidence.map((row) => [row.memory_id, row.evidence_key, row.content_hash, row.proposition_fingerprint, row.retired_at]),
    episodes: dependencies.episodes.map((row) => [row.id, row.session_id, row.updated_at, row.repository, row.summary]),
    checkpoints: dependencies.checkpoints.map((row) => [row.client, row.session_id, row.checkpoint_revision, row.revision, row.offset, row.failure_code, row.adapter_state_json]),
    dependent: Object.fromEntries(Object.entries(dependencies.dependent).map(([key, rows]) => [key, rows.map((row) => row)])),
    mappings: tableExists(db.db, "repository_identity_mapping") ? db.db.prepare("SELECT legacy, canonical, updated_at FROM repository_identity_mapping ORDER BY legacy").all() : [],
    suppressions: tableExists(db.db, "memory_suppression") ? db.db.prepare("SELECT suppression_key, memory_id, canonical_fingerprint, scope, repository, evidence_fingerprint, superseded_at, repair_candidate FROM memory_suppression ORDER BY suppression_key").all() : [],
    sourceHashes: repair.sourceHashes,
    repairCandidates: repair.candidates.map((candidate) => [candidate.candidateId, candidate.evidenceKey, candidate.memory.type, candidate.memory.content, candidate.memory.scope, candidate.memory.repository ?? null, candidate.existing.map((row) => row.id)]),
  };
  state.daySummaries = dependencies.daySummaries.map((row) => row);
  state.repositoryMappings = tableExists(db.db, "repository_identity_mapping")
    ? db.db.prepare("SELECT * FROM repository_identity_mapping ORDER BY legacy").all()
    : [];
  if (request.repository) state.repositoryDependencies = Object.fromEntries(Object.entries(collectRepositoryDependencies(db.db, request.repository, request.limit)).map(([key, rows]) => [key, rows.map((row) => row.id ?? row.session_id ?? row.observation_key ?? row.domain_key ?? row.task_name ?? row.scope_key ?? row.repository ?? row)]));
  return hash(state);
}

function buildBackupPlan(db) {
  const backupDir = db.config.paths.backupDir;
  return { plannedPath: path.join(backupDir, `lore-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.db`), created: false };
}

function unresolvedFor(request, dependencies) {
  const unresolved = [];
  if (request.operation === "correct" && dependencies.memories.length === 0) unresolved.push({ code: "MEMORY_NOT_FOUND", selector: request.memoryIds[0] });
  if (request.memoryIds.length > dependencies.memories.length) unresolved.push({ code: "MEMORY_NOT_FOUND", selector: request.memoryIds.filter((id) => !dependencies.memories.some((row) => row.id === id)) });
  if (request.repository && dependencies.memories.some((row) => normalizeRepository(row.repository) !== request.repository)) {
    unresolved.push({ code: "FOREIGN_TARGET", selector: request.memoryIds, detail: "selected memory does not belong to the requested repository" });
  }
  if (request.operation === "repair") {
    if (request.memoryIds.length > 0 && dependencies.memories.length === 0) unresolved.push({ code: "MEMORY_NOT_FOUND", selector: request.memoryIds });
    if (request.sessionIds.length > 0 && dependencies.episodes.length === 0) unresolved.push({ code: "SOURCE_NOT_FOUND", selector: request.sessionIds });
    if (dependencies.checkpoints.length > 0) {
      const missingSources = dependencies.checkpoints.filter((row) => {
        const adapterState = parseObject(row.adapter_state_json);
        const sourcePath = adapterState.sourcePath;
        try { return !sourcePath || !existsSync(sourcePath) || !lstatSync(sourcePath).isFile(); } catch { return true; }
      }).map((row) => `${row.client}:${row.session_id}`);
      if (missingSources.length > 0) unresolved.push({ code: "SOURCE_UNAVAILABLE", selector: missingSources, detail: "validated transcript source is unavailable; no evidence was invented" });
    }
    if (request.repositoryMappings.length > 0) {
      for (const mapping of request.repositoryMappings) {
        const rows = collectRepositoryDependencies(dbFromDependencies(dependencies), mapping.legacy, request.limit);
        if (Object.values(rows).every((items) => items.length === 0)) unresolved.push({ code: "LEGACY_IDENTITY_NOT_FOUND", selector: mapping.legacy });
        const canonicalRows = collectRepositoryDependencies(dbFromDependencies(dependencies), mapping.canonical, request.limit);
        const legacyDays = rows.day_summary ?? [];
        const canonicalDays = canonicalRows.day_summary ?? [];
        const legacyEvidence = rows.session_evidence ?? [];
        const canonicalEvidence = canonicalRows.session_evidence ?? [];
        const legacyCheckpoints = rows.ingestion_checkpoint ?? [];
        const canonicalCheckpoints = canonicalRows.ingestion_checkpoint ?? [];
        const collision = legacyDays.some((legacyRow) => canonicalDays.some((canonicalRow) => legacyRow.date_key === canonicalRow.date_key))
          || legacyEvidence.some((legacyRow) => canonicalEvidence.some((canonicalRow) => legacyRow.evidence_key === canonicalRow.evidence_key))
          || legacyCheckpoints.some((legacyRow) => canonicalCheckpoints.some((canonicalRow) => legacyRow.client === canonicalRow.client && legacyRow.session_id === canonicalRow.session_id));
        if (collision) {
          unresolved.push({ code: "MAPPING_COLLISION", selector: mapping, detail: "both legacy and canonical derived records exist; select and reconcile the conflicting candidates explicitly" });
        }
      }
    }
  }
  if (request.operation === "purge" && request.repository) {
    const repositoryDependencies = collectRepositoryDependencies(dbFromDependencies(dependencies), request.repository, request.limit);
    if (Object.values(repositoryDependencies).some((rows) => rows.length >= request.limit)) unresolved.push({ code: "BOUND_REACHED", selector: request.repository, limit: request.limit });
  }
  if (request.operation === "purge" && request.scope === MEMORY_SCOPE.GLOBAL && dependencies.memories.length >= request.limit) unresolved.push({ code: "BOUND_REACHED", selector: "global", limit: request.limit });
  if (request.operation === "purge" && !request.includeDependentAggregates) {
    const unknownAggregates = dependencies.daySummaries.filter((row) => jsonArray(row.episode_ids_json).length === 0).map((row) => JSON.stringify([row.date_key, row.repository]));
    if (unknownAggregates.length > 0) unresolved.push({ code: "AGGREGATE_PROVENANCE_UNKNOWN", selector: unknownAggregates, detail: "aggregate has no surviving episode provenance; set includeDependentAggregates and select preview IDs to remove it" });
  }
  return unresolved;
}

// Kept as a narrow helper to make unresolved evaluation safe with fixture/mocked dbs.
function dbFromDependencies(dependencies) { return dependencies._db; }

function parseObject(value) {
  try { const parsed = JSON.parse(value ?? "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

function sourceHash(sourcePath) {
  const stat = statSync(sourcePath);
  const bytes = readFileSync(sourcePath);
  return {
    path: sourcePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

function checkpointSourceHashes(checkpoints) {
  const hashes = [];
  for (const checkpoint of checkpoints) {
    const sourcePath = parseObject(checkpoint.adapter_state_json).sourcePath;
    if (!sourcePath) continue;
    try {
      const source = sourceHash(sourcePath);
      hashes.push({ sessionId: checkpoint.session_id, sourceIdentity: checkpoint.source_identity ?? null, size: source.size, mtimeMs: source.mtimeMs, contentHash: source.contentHash });
    } catch {
      hashes.push({ sessionId: checkpoint.session_id, sourceIdentity: checkpoint.source_identity ?? null, unavailable: true });
    }
  }
  return hashes;
}

function buildRepairCandidates(db, request, dependencies) {
  const sessions = dependencies.sessions;
  const candidates = [];
  const sourceHashes = [];
  const unresolved = [];
  const checkpoints = dependencies.checkpoints?.length > 0
    ? dependencies.checkpoints
    : sessions.length > 0 && tableExists(db.db, "ingestion_checkpoint")
      ? db.db.prepare(`SELECT * FROM ingestion_checkpoint WHERE session_id IN (${sessions.map(() => "?").join(",")})`).all(...sessions)
      : [];
  for (const sessionId of sessions) {
    const checkpoint = checkpoints.find((row) => row.session_id === sessionId);
    const adapterState = parseObject(checkpoint?.adapter_state_json);
    const sourcePath = adapterState.sourcePath;
    if (!checkpoint || !sourcePath) {
      unresolved.push({ code: "SOURCE_UNAVAILABLE", selector: sessionId, detail: "no validated sourcePath is recorded for this session" });
      continue;
    }
    try {
      if (!lstatSync(sourcePath).isFile()) throw new Error("source is not a regular file");
      const source = sourceHash(sourcePath);
      sourceHashes.push({ sessionId, sourceIdentity: checkpoint.source_identity ?? null, size: source.size, mtimeMs: source.mtimeMs, contentHash: source.contentHash });
      const client = checkpoint.client;
      const repository = checkpoint.repository ?? request.repository ?? null;
      const artifacts = parseCliTranscript(source.bytes.toString("utf8"), {
        client,
        sessionId,
        cwd: adapterState.sourceCwd ?? null,
        repository,
        timestamp: new Date(source.mtimeMs).toISOString(),
      });
      const extraction = extractSessionMemories({
        sessionId,
        repository,
        sessionArtifacts: artifacts,
        workspace: { workspace: { repository, updated_at: artifacts.session.updated_at } },
        config: db.config,
      });
      for (const memory of extraction.semanticMemories ?? []) {
        const evidence = normalizeEvidence({ sessionId, memory, repository });
        const candidateId = `repair:${hash({ sessionId, evidenceKey: evidence.key, content: memory.content, type: memory.type, scope: memory.scope, repository })}`;
        const existing = db.db.prepare(`SELECT sm.id, sm.type, sm.content, sm.scope, sm.repository FROM memory_evidence me JOIN semantic_memory sm ON sm.id = me.memory_id WHERE me.evidence_key = ? AND me.retired_at IS NULL ORDER BY sm.id`).all(evidence.key);
        candidates.push({ candidateId, sessionId, evidenceKey: evidence.key, memory, existing });
      }
    } catch {
      unresolved.push({ code: "SOURCE_UNAVAILABLE", selector: sessionId, detail: "validated source could not be deterministically parsed" });
    }
  }
  return { candidates, sourceHashes, unresolved };
}

function makeReport(db, request, dependencies) {
  dependencies._db = db.db;
  const repair = request.operation === "repair" ? buildRepairCandidates(db, request, dependencies) : { candidates: [], sourceHashes: [], unresolved: [] };
  const sourceHashes = request.operation === "repair" ? repair.sourceHashes : checkpointSourceHashes(dependencies.checkpoints);
  const unresolved = [...unresolvedFor(request, dependencies), ...repair.unresolved];
  const affected = {
    memoryIds: dependencies.memories.map((row) => row.id),
    sessionIds: dependencies.sessions,
    episodeIds: dependencies.episodes.map((row) => row.id),
    evidenceKeys: dependencies.evidence.map((row) => row.evidence_key),
    daySummaryKeys: dependencies.daySummaries.map((row) => JSON.stringify([row.date_key, row.repository])),
    checkpointKeys: dependencies.checkpoints.map((row) => `${row.client}:${row.session_id}`),
  };
  for (const [key, rows] of Object.entries(dependencies.dependent)) {
    affected[key] = rows.map((row) => row.id ?? row.domain_key ?? row.observation_key ?? `${row.run_id}:${row.session_id}`);
  }
  if (request.repository) {
    const repositoryRows = collectRepositoryDependencies(db.db, request.repository, request.limit);
    for (const [table, rows] of Object.entries(repositoryRows)) affected[table] = rows.map((row) => row.id ?? row.session_id ?? row.observation_key ?? row.domain_key ?? row.task_name ?? row.scope_key ?? `${row.date_key}:${row.repository}`);
  }
  const mappingCandidateIds = request.repositoryMappings.map(({ legacy, canonical }) => `mapping:${legacy}->${canonical}`);
  const stateFingerprint = fingerprintState(db, request, dependencies, { ...repair, sourceHashes });
  const report = {
    action: request.action,
    operation: request.operation,
    selectors: { memoryIds: request.memoryIds, sessionIds: request.sessionIds, repository: request.repository, repositoryMappings: request.repositoryMappings },
    affected,
    affectedCount: Object.fromEntries(Object.entries(affected).map(([key, values]) => [key, values.length])),
    unresolvedCandidates: unresolved,
    planFingerprint: hash({ request: planRequest(request), stateFingerprint, affected }),
    affectedStateFingerprint: stateFingerprint,
    backup: request.action === "preview" ? buildBackupPlan(db) : null,
    integrity: "not_checked",
    retention: {
      rawSources: "retained",
      existingBackups: "retained",
      snapshot: request.action === "apply" ? "created_before_mutation" : "planned_before_mutation",
      secureErasure: false,
      suppression: "minimal_non_plaintext_suppression_retained",
    },
    candidateIds: [...new Set([...Object.values(affected).flat(), ...mappingCandidateIds])],
  };
  if (repair.candidates.length > 0) {
    report.repairCandidates = repair.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      sessionId: candidate.sessionId,
      evidenceKey: candidate.evidenceKey,
      proposed: { type: candidate.memory.type, content: candidate.memory.content, scope: candidate.memory.scope, repository: candidate.memory.repository ?? null },
      existingMemoryIds: candidate.existing.map((row) => row.id),
    }));
    report.candidateIds.push(...repair.candidates.map((candidate) => candidate.candidateId));
  }
  if (sourceHashes.length > 0) report.sourceHashes = sourceHashes;
  if (request.operation === "correct" && dependencies.memories[0]) {
    report.old = { id: dependencies.memories[0].id, type: dependencies.memories[0].type, content: dependencies.memories[0].content, scope: dependencies.memories[0].scope, repository: dependencies.memories[0].repository, evidenceKeys: affected.evidenceKeys };
    report.replacement = { content: request.content ?? dependencies.memories[0].content, type: request.type ?? dependencies.memories[0].type, scope: request.scope ?? dependencies.memories[0].scope, repository: request.repository ?? dependencies.memories[0].repository };
  }
  if (request.operation === "repair") {
    report.source = dependencies.checkpoints.map((row) => {
      const adapterState = parseObject(row.adapter_state_json);
      const sourcePath = adapterState.sourcePath;
      let available = false;
      try { available = Boolean(sourcePath && existsSync(sourcePath) && lstatSync(sourcePath).isFile()); } catch { /* report unavailable */ }
      return { client: row.client, sessionId: row.session_id, available, sourceIdentity: row.source_identity ?? null };
    });
  }
  return report;
}

function planRequest(request) {
  const { action: _action, selectedCandidateIds: _selectedCandidateIds, ...stableRequest } = request;
  return { ...stableRequest, action: "preview" };
}

export function previewMemoryAdministration(db, requestInput) {
  const request = normalizeAdministrationRequest(requestInput);
  if (request.action !== "preview") return previewMemoryAdministration(db, { ...request, action: "preview" });
  db.ensureOpen();
  const memories = request.operation === "purge" && request.repository ? rowsForRepository(db.db, "semantic_memory", "repository", request.repository, request.limit) : selectedMemories(db.db, request);
  const dependencies = allAffectedRows(db.db, request, memories);
  return makeReport(db, request, dependencies);
}

function assertFreshPlan(db, request, planFingerprint) {
  const current = previewMemoryAdministration(db, { ...request, action: "preview" });
  if (current.unresolvedCandidates.length > 0) throw new Error(`administration target is unresolved: ${current.unresolvedCandidates.map((item) => item.code).join(", ")}`);
  if (current.planFingerprint !== planFingerprint) throw new Error("administration plan fingerprint is stale; preview again");
  return current;
}

function insertCorrection(db, old, request) {
  const type = request.type ?? old.type;
  const scope = request.scope ?? old.scope;
  const repository = scope === MEMORY_SCOPE.GLOBAL || scope === MEMORY_SCOPE.TRANSFERABLE
    ? null
    : request.repository ?? old.repository;
  const replacementId = crypto.randomUUID();
  const metadata = {
    source: "memory_save",
    correctionOf: old.id,
    correctionReason: request.reason,
    correctionProvenance: { kind: "memory_correct", sourceMemoryId: old.id },
  };
  const replacementContent = request.content ?? old.content;
  const canonicalKey = buildSemanticCanonicalKey({ type, content: replacementContent, metadata });
  db.db.prepare(`
    INSERT INTO semantic_memory (id, type, content, confidence, source_session_id, source_turn_index, scope, scope_source, repository, domain_key, tags, created_at, updated_at, superseded_by, canonical_key, reinforcement_count, last_seen_at, expires_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?)
  `).run(replacementId, type, replacementContent, old.confidence, old.source_session_id, old.source_turn_index, scope, repository, old.domain_key, `${old.tags ?? ""} manual correction`.trim(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), old.expires_at ?? null, JSON.stringify(metadata));
  db.db.prepare("UPDATE semantic_memory SET canonical_key = ? WHERE id = ?").run(canonicalKey, replacementId);
  // Keep correction tombstones identical to the normal forget lifecycle. It
  // records every active evidence fingerprint and the same canonical hash
  // consumed by future generated writes.
  db.forgetMemory({ id: old.id, supersededBy: replacementId, actor: "memory_correct", reason: request.reason });
  return replacementId;
}

function purgeRows(db, request, report) {
  const ids = report.affected.memoryIds;
  const sessions = report.affected.sessionIds;
  const selected = new Set(request.selectedCandidateIds);
  const deleteByIds = (table, column, values) => {
    if (!tableExists(db.db, table) || values.length === 0) return;
    db.db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${values.map(() => "?").join(",")})`).run(...values);
  };
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.db.prepare(`SELECT id, type, content, canonical_key, scope, repository FROM semantic_memory WHERE id IN (${placeholders})`).all(...ids);
    for (const row of rows) db.forgetMemory({ id: row.id, actor: "memory_purge", reason: request.reason });
    if (tableExists(db.db, "memory_embedding")) db.db.prepare(`DELETE FROM memory_embedding WHERE memory_id IN (${placeholders})`).run(...ids);
    if (tableExists(db.db, "memory_evidence")) db.db.prepare(`DELETE FROM memory_evidence WHERE memory_id IN (${placeholders})`).run(...ids);
    db.db.prepare(`DELETE FROM semantic_memory WHERE id IN (${placeholders})`).run(...ids);
    if (request.includeDependentAggregates) {
      deleteByIds("memory_domain", "domain_key", (report.affected.domains ?? []).filter((id) => selected.has(id)));
      deleteByIds("refreshable_observation", "observation_key", (report.affected.observations ?? []).filter((id) => selected.has(id)));
    }
    deleteByIds("improvement_backlog", "id", report.affected.improvements ?? []);
    deleteByIds("scope_override_audit", "id", report.affected.scopeAudits ?? []);
    deleteByIds("trajectory_artifact", "id", report.affected.trajectories ?? []);
    deleteByIds("retrieval_trace_sample", "id", report.affected.retrievalTraces ?? []);
  }
  if (sessions.length > 0 && tableExists(db.db, "episode_digest")) {
    const removableSessions = sessions.filter((sessionId) => {
      const remaining = db.db.prepare("SELECT 1 FROM semantic_memory WHERE source_session_id = ? AND superseded_by IS NULL LIMIT 1").get(sessionId);
      return !remaining;
    });
    if (removableSessions.length > 0) {
      const removable = removableSessions.map(() => "?").join(",");
      db.db.prepare(`DELETE FROM episode_digest WHERE session_id IN (${removable})`).run(...removableSessions);
      if (tableExists(db.db, "deferred_extraction")) db.db.prepare(`DELETE FROM deferred_extraction WHERE session_id IN (${removable})`).run(...removableSessions);
      if (tableExists(db.db, "ingestion_checkpoint")) db.db.prepare(`DELETE FROM ingestion_checkpoint WHERE session_id IN (${removable})`).run(...removableSessions);
      if (tableExists(db.db, "intent_journal")) db.db.prepare(`DELETE FROM intent_journal WHERE session_id IN (${removable})`).run(...removableSessions);
      if (tableExists(db.db, "backfill_run_item")) db.db.prepare(`DELETE FROM backfill_run_item WHERE session_id IN (${removable})`).run(...removableSessions);
    }
    if (tableExists(db.db, "session_evidence") && report.affected.evidenceKeys.length > 0) {
      const evidencePlaceholders = report.affected.evidenceKeys.map(() => "?").join(",");
      db.db.prepare(`DELETE FROM session_evidence WHERE evidence_key IN (${evidencePlaceholders}) AND NOT EXISTS (SELECT 1 FROM memory_evidence WHERE memory_evidence.evidence_key = session_evidence.evidence_key)`).run(...report.affected.evidenceKeys);
    }
    if (tableExists(db.db, "day_summary")) {
      for (const key of report.affected.daySummaryKeys) {
        const [date, repository] = jsonArray(key);
        const summary = db.db.prepare("SELECT episode_ids_json FROM day_summary WHERE date_key = ? AND repository = ?").get(date, repository);
        const episodeIds = jsonArray(summary?.episode_ids_json);
        if (episodeIds.every((id) => sessions.includes(id))) db.db.prepare("DELETE FROM day_summary WHERE date_key = ? AND repository = ?").run(date, repository);
        else db.refreshDaySummary(date, repository);
      }
    }
  }
  if (request.repository) {
    for (const [table, column] of DERIVED_REPOSITORY_TABLES) {
      if (["semantic_memory", "episode_digest", "session_evidence", "deferred_extraction", "ingestion_checkpoint"].includes(table)) continue;
      if (!tableExists(db.db, table)) continue;
      if (["memory_domain", "refreshable_observation"].includes(table)) {
        if (!request.includeDependentAggregates) continue;
        const ids = table === "memory_domain" ? (report.affected.domains ?? []) : (report.affected.observations ?? []);
        const chosen = ids.filter((id) => selected.has(id));
        if (chosen.length > 0) deleteByIds(table, table === "memory_domain" ? "domain_key" : "observation_key", chosen);
        continue;
      }
      if (table === "improvement_backlog") {
        db.db.prepare("DELETE FROM improvement_backlog WHERE repository = ? AND (linked_memory_id IS NULL OR NOT EXISTS (SELECT 1 FROM semantic_memory WHERE id = improvement_backlog.linked_memory_id AND superseded_by IS NULL))").run(request.repository);
        continue;
      }
      db.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(request.repository);
    }
    if (tableExists(db.db, "episode_digest")) db.db.prepare("DELETE FROM episode_digest WHERE repository = ? AND NOT EXISTS (SELECT 1 FROM semantic_memory WHERE source_session_id = episode_digest.session_id AND superseded_by IS NULL)").run(request.repository);
    if (tableExists(db.db, "deferred_extraction")) db.db.prepare("DELETE FROM deferred_extraction WHERE repository = ? AND NOT EXISTS (SELECT 1 FROM semantic_memory WHERE source_session_id = deferred_extraction.session_id AND superseded_by IS NULL)").run(request.repository);
    if (tableExists(db.db, "ingestion_checkpoint")) db.db.prepare("DELETE FROM ingestion_checkpoint WHERE repository = ? AND NOT EXISTS (SELECT 1 FROM semantic_memory WHERE source_session_id = ingestion_checkpoint.session_id AND superseded_by IS NULL)").run(request.repository);
    if (tableExists(db.db, "session_evidence")) db.db.prepare("DELETE FROM session_evidence WHERE repository = ? AND NOT EXISTS (SELECT 1 FROM memory_evidence WHERE memory_evidence.evidence_key = session_evidence.evidence_key)").run(request.repository);
    if (tableExists(db.db, "scope_override_audit")) db.db.prepare("DELETE FROM scope_override_audit WHERE previous_repository = ? OR next_repository = ?").run(request.repository, request.repository);
  }
}

function jsonArray(value) {
  try { const parsed = JSON.parse(value ?? "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function repairMappings(db, mappings, selectedCandidateIds = null) {
  const tables = DERIVED_REPOSITORY_TABLES;
  for (const { legacy, canonical } of mappings) {
    if (selectedCandidateIds && !selectedCandidateIds.has(`mapping:${legacy}->${canonical}`)) continue;
    for (const [table, column] of tables) if (tableExists(db.db, table)) db.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(canonical, legacy);
    if (tableExists(db.db, "scope_override_audit")) db.db.prepare("UPDATE scope_override_audit SET previous_repository = CASE WHEN previous_repository = ? THEN ? ELSE previous_repository END, next_repository = CASE WHEN next_repository = ? THEN ? ELSE next_repository END").run(legacy, canonical, legacy, canonical);
    if (tableExists(db.db, "repository_identity_mapping")) db.setRepositoryMapping({ legacy, canonical });
  }
}

export function applyMemoryAdministration(db, requestInput, planFingerprint) {
  const request = normalizeAdministrationRequest(Object.assign({}, requestInput, { action: "apply" }));
  const plan = assertFreshPlan(db, request, planFingerprint);
  if (plan.unresolvedCandidates.length > 0) throw new Error("administration plan contains unresolved candidates");
  if (request.operation === "repair" && request.selectedCandidateIds.some((id) => !plan.candidateIds.includes(id))) {
    throw new Error("selectedCandidateIds must come from the preview report");
  }
  let snapshot;
  try {
    snapshot = createRecoverySnapshot({ derivedStorePath: db.config.paths.derivedStorePath, backupDir: db.config.paths.backupDir });
  } catch (error) {
    throw new Error(`administration snapshot failed; no writes were made: ${error.message}`, { cause: error });
  }
  let replacementId = null;
  db.withSemanticMemoryTransaction(() => {
    const transactionPlan = previewMemoryAdministration(db, request);
    if (transactionPlan.planFingerprint !== plan.planFingerprint) throw new Error("administration plan fingerprint changed after snapshot; no writes were made");
    if (request.operation === "correct") replacementId = insertCorrection(db, plan.old && db.db.prepare("SELECT * FROM semantic_memory WHERE id = ?").get(plan.old.id), request);
    if (request.operation === "purge") purgeRows(db, request, plan);
    if (request.operation === "repair") {
      const sessions = [...new Set([...request.sessionIds, ...plan.affected.sessionIds])];
      const memories = sessions.length > 0 ? selectedMemories(db.db, { ...request, memoryIds: [], sessionIds: sessions }) : rowsForIds(db.db, plan.affected.memoryIds ?? []);
      const dependencies = allAffectedRows(db.db, { ...request, sessionIds: sessions }, memories);
      const repair = buildRepairCandidates(db, request, dependencies);
      const selected = new Set(request.selectedCandidateIds);
      const bySession = new Map();
      for (const candidate of repair.candidates) {
        if (!selected.has(candidate.candidateId)) continue;
        if (!bySession.has(candidate.sessionId)) bySession.set(candidate.sessionId, []);
        bySession.get(candidate.sessionId).push(candidate.memory);
      }
      for (const [sessionId, memories] of bySession) {
        const repository = memories[0]?.repository ?? request.repository ?? null;
        db.reconcileGeneratedMemories({ sessionId, repository, memories });
      }
      repairMappings(db, request.repositoryMappings, selected);
    }
  });
  const validation = inspectDatabase(db.config.paths.derivedStorePath);
  const result = { ...plan, action: "apply", backup: { ...snapshot, created: true }, integrity: validation.integrity === "ok" ? "ok" : "applied_with_verification_failure", applied: true };
  if (replacementId) result.replacementId = replacementId;
  return result;
}

export function memoryCorrect(db, request) { return request?.action === "apply" ? applyMemoryAdministration(db, request, request.planFingerprint) : previewMemoryAdministration(db, { ...request, operation: "correct" }); }
export function memoryRepair(db, request) { return request?.action === "apply" ? applyMemoryAdministration(db, request, request.planFingerprint) : previewMemoryAdministration(db, { ...request, operation: "repair" }); }
export function memoryPurge(db, request) { return request?.action === "apply" ? applyMemoryAdministration(db, request, request.planFingerprint) : previewMemoryAdministration(db, { ...request, operation: "purge" }); }
export const previewMemoryCorrection = previewMemoryAdministration;
export const previewMemoryRepair = previewMemoryAdministration;
export const previewMemoryPurge = previewMemoryAdministration;
export const applyMemoryCorrection = applyMemoryAdministration;
export const applyMemoryRepair = applyMemoryAdministration;
export const applyMemoryPurge = applyMemoryAdministration;
