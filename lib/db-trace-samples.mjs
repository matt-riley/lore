import crypto from "node:crypto";

import {
  clampInteger,
  normalizeRepository,
  parseJsonArray,
  parseJsonObject,
} from "./data-utils.mjs";

function nowIso() {
  return new Date().toISOString();
}

function normalizeTraceScalarFields({ id, repository, scopeType, normalizedHook, route, routeReason, contextInjected, latencyMs, promptPreview }) {
  return {
    id: id || crypto.randomUUID(),
    repository: normalizeRepository(repository),
    scopeType,
    hook: normalizedHook,
    route: route ? String(route) : null,
    routeReason: routeReason ? String(routeReason) : null,
    contextInjected: contextInjected ? 1 : 0,
    latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    promptPreview: String(promptPreview || ""),
  };
}

function normalizeTraceJsonFields({ promptNeed, eligibility, lookups, omissions, output, trace }) {
  return {
    promptNeed: JSON.stringify(promptNeed ?? {}),
    eligibility: JSON.stringify(eligibility ?? {}),
    lookups: JSON.stringify(lookups ?? {}),
    omissions: JSON.stringify(Array.isArray(omissions) ? omissions : []),
    output: JSON.stringify(output ?? {}),
    trace: JSON.stringify(trace ?? {}),
  };
}

// --- Retrieval trace sample operations (called by class methods) ---

export function buildRetrievalTraceSampleRecordImpl(instance, {
  id = null,
  repository = null,
  scopeType = "repo",
  hook,
  route = null,
  routeReason = null,
  contextInjected = false,
  latencyMs = null,
  promptPreview = "",
  sectionTitles = [],
  promptNeed = {},
  eligibility = {},
  lookups = {},
  omissions = [],
  output = {},
  trace = {},
  recordedAt = nowIso(),
}) {
  const normalizedHook = instance.normalizeRetrievalTraceHook(hook);
  if (!normalizedHook) {
    throw new Error("hook is required");
  }
  return {
    ...normalizeTraceScalarFields({
      id, repository, scopeType: instance.normalizeRetrievalTraceScopeType(scopeType),
      normalizedHook, route, routeReason, contextInjected, latencyMs, promptPreview,
    }),
    sectionTitles: instance.normalizeRetrievalTraceSectionTitles(sectionTitles),
    ...normalizeTraceJsonFields({ promptNeed, eligibility, lookups, omissions, output, trace }),
    recordedAt,
  };
}

export function pruneRetrievalTraceSamplesImpl(db, {
  repository = null,
  maxRowsPerRepository = 120,
  maxRowsGlobal = 240,
  maxAgeMs = 14 * 24 * 60 * 60 * 1000,
} = {}) {
  let removed = 0;
  const cutoffIso = new Date(Date.now() - clampInteger(maxAgeMs, 14 * 24 * 60 * 60 * 1000, {
    min: 60 * 60 * 1000,
    max: 365 * 24 * 60 * 60 * 1000,
  })).toISOString();
  const ageRemoved = db.prepare(`
    DELETE FROM retrieval_trace_sample
    WHERE recorded_at < ?
  `).run(cutoffIso).changes ?? 0;
  removed += ageRemoved;

  const repo = normalizeRepository(repository);
  if (repo) {
    const over = db.prepare(`
      SELECT COUNT(*) AS count
      FROM retrieval_trace_sample
      WHERE repository = ?
    `).get(repo)?.count ?? 0;
    const limit = clampInteger(maxRowsPerRepository, 120, { min: 10, max: 2000 });
    if (over > limit) {
      removed += db.prepare(`
        DELETE FROM retrieval_trace_sample
        WHERE id IN (
          SELECT id
          FROM retrieval_trace_sample
          WHERE repository = ?
          ORDER BY recorded_at DESC
          LIMIT -1 OFFSET ?
        )
      `).run(repo, limit).changes ?? 0;
    }
  }

  const globalCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM retrieval_trace_sample
    WHERE repository IS NULL OR repository = ''
  `).get()?.count ?? 0;
  const globalLimit = clampInteger(maxRowsGlobal, 240, { min: 20, max: 5000 });
  if (globalCount > globalLimit) {
    removed += db.prepare(`
      DELETE FROM retrieval_trace_sample
      WHERE id IN (
        SELECT id
        FROM retrieval_trace_sample
        WHERE repository IS NULL OR repository = ''
        ORDER BY recorded_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(globalLimit).changes ?? 0;
  }

  return { removed };
}

export function listRetrievalTraceSamplesImpl(db, {
  repository,
  includeGlobal = true,
  limit = 10,
} = {}) {
  const where = [];
  const params = [];
  const repo = normalizeRepository(repository);
  if (repo && includeGlobal) {
    where.push("(repository = ? OR repository IS NULL OR repository = '')");
    params.push(repo);
  } else if (repo) {
    where.push("repository = ?");
    params.push(repo);
  } else if (includeGlobal) {
    // no filter
  } else {
    where.push("repository IS NOT NULL AND repository != ''");
  }
  params.push(clampInteger(limit, 10, { min: 1, max: 100 }));
  const rows = db.prepare(`
    SELECT
      id,
      repository,
      scope_type,
      hook,
      route,
      route_reason,
      context_injected,
      latency_ms,
      prompt_preview,
      section_titles_json,
      prompt_need_json,
      eligibility_json,
      lookups_json,
      omissions_json,
      output_json,
      trace_json,
      recorded_at
    FROM retrieval_trace_sample
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY recorded_at DESC
    LIMIT ?
  `).all(...params);

  return rows.map((row) => ({
    id: row.id,
    repository: row.repository,
    scopeType: row.scope_type,
    hook: row.hook,
    route: row.route,
    routeReason: row.route_reason,
    contextInjected: row.context_injected === 1,
    latencyMs: row.latency_ms,
    promptPreview: row.prompt_preview,
    sectionTitles: parseJsonArray(row.section_titles_json),
    promptNeed: parseJsonObject(row.prompt_need_json),
    eligibility: parseJsonObject(row.eligibility_json),
    lookups: parseJsonObject(row.lookups_json),
    omissions: parseJsonArray(row.omissions_json),
    output: parseJsonObject(row.output_json),
    trace: parseJsonObject(row.trace_json),
    recordedAt: row.recorded_at,
  }));
}
