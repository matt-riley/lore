import { buildMemoryDomain } from "../memory/memory-domains.mjs";
import { buildRefreshableObservation } from "../sessions/observations.mjs";
import { parseJsonArray } from "../utils/json-array-utils.mjs";
import { parseJsonObject } from "../utils/json-object-utils.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { normalizeText } from "../utils/text-normalizer.mjs";
import { nowIso, applyScopeFilter } from "./db-shared.mjs";

function mapMemoryDomainRow(row) {
  return {
    domainKey: row.domain_key,
    kind: row.kind,
    title: row.title,
    mission: row.mission,
    scope: row.scope,
    repository: row.repository,
    directives: parseJsonArray(row.directives_json),
    disposition: parseJsonObject(row.disposition_json),
    metadata: parseJsonObject(row.metadata_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function mapObservationRow(row) {
  return {
    observationKey: row.observation_key,
    domainKey: row.domain_key,
    title: row.title,
    prompt: row.prompt,
    focus: row.focus,
    summary: row.summary,
    confidence: row.confidence,
    scope: row.scope,
    repository: row.repository,
    freshnessHours: row.freshness_hours,
    status: row.status,
    source: row.source,
    trace: parseJsonObject(row.trace_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRefreshedAt: row.last_refreshed_at,
  };
}

export function upsertMemoryDomain(owner, domain) {
  owner.ensureOpen();
  const normalized = buildMemoryDomain(domain);
  if (!normalized) {
    throw new Error("invalid memory domain");
  }
  const timestamp = nowIso();
  owner.db.prepare(`
    INSERT INTO memory_domain (
      domain_key, kind, title, mission, scope, repository, directives_json,
      disposition_json, metadata_json, status, created_at, updated_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain_key) DO UPDATE SET
      kind = excluded.kind,
      title = excluded.title,
      mission = excluded.mission,
      scope = excluded.scope,
      repository = excluded.repository,
      directives_json = excluded.directives_json,
      disposition_json = excluded.disposition_json,
      metadata_json = excluded.metadata_json,
      status = excluded.status,
      updated_at = excluded.updated_at,
      last_used_at = COALESCE(excluded.last_used_at, memory_domain.last_used_at)
  `).run(
    normalized.domainKey,
    normalized.kind,
    normalized.title,
    normalized.mission,
    normalized.scope,
    normalized.repository,
    JSON.stringify(normalized.directives),
    JSON.stringify(normalized.disposition),
    JSON.stringify(normalized.metadata),
    normalized.status,
    timestamp,
    timestamp,
    domain.lastUsedAt ?? null,
  );
  return normalized.domainKey;
}

export function getMemoryDomain(owner, domainKey) {
  owner.ensureOpen();
  const normalizedDomainKey = normalizeText(domainKey).toLowerCase();
  if (!normalizedDomainKey) {
    return null;
  }
  const row = owner.db.prepare(`
    SELECT
      domain_key, kind, title, mission, scope, repository, directives_json,
      disposition_json, metadata_json, status, created_at, updated_at, last_used_at
    FROM memory_domain
    WHERE domain_key = ?
    LIMIT 1
  `).get(normalizedDomainKey);
  if (!row) {
    return null;
  }
  return mapMemoryDomainRow(row);
}

export function listMemoryDomains(owner, { repository, includeOtherRepositories = false, scopes = [], status } = {}) {
  owner.ensureOpen();
  const repo = normalizeRepository(repository);
  const params = [];
  let sql = `
    SELECT
      domain_key, kind, title, mission, scope, repository, directives_json,
      disposition_json, metadata_json, status, created_at, updated_at, last_used_at
    FROM memory_domain
    WHERE 1 = 1
  `;
  sql = applyScopeFilter(sql, params, repo, includeOtherRepositories);
  if (scopes.length > 0) {
    sql += ` AND scope IN (${scopes.map(() => "?").join(", ")}) `;
    params.push(...scopes);
  }
  if (status) {
    sql += ` AND status = ? `;
    params.push(normalizeText(status).toLowerCase());
  }
  sql += ` ORDER BY updated_at DESC, domain_key ASC `;
  return owner.db.prepare(sql).all(...params).map(mapMemoryDomainRow);
}

export function upsertObservation(owner, observation) {
  owner.ensureOpen();
  const normalized = buildRefreshableObservation(observation);
  if (!normalized) {
    throw new Error("invalid refreshable observation");
  }
  const timestamp = nowIso();
  const lastRefreshedAt = observation.lastRefreshedAt ?? timestamp;
  owner.db.prepare(`
    INSERT INTO refreshable_observation (
      observation_key, domain_key, title, prompt, focus, summary, confidence, scope,
      repository, freshness_hours, status, source, trace_json, metadata_json,
      created_at, updated_at, last_refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(observation_key) DO UPDATE SET
      domain_key = excluded.domain_key,
      title = excluded.title,
      prompt = excluded.prompt,
      focus = excluded.focus,
      summary = excluded.summary,
      confidence = excluded.confidence,
      scope = excluded.scope,
      repository = excluded.repository,
      freshness_hours = excluded.freshness_hours,
      status = excluded.status,
      source = excluded.source,
      trace_json = excluded.trace_json,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at,
      last_refreshed_at = excluded.last_refreshed_at
  `).run(
    normalized.observationKey,
    normalized.domainKey,
    normalized.title,
    normalized.prompt,
    normalized.focus,
    normalized.summary,
    normalized.confidence,
    normalized.scope,
    normalized.repository,
    normalized.freshnessHours,
    normalized.status,
    normalized.source,
    JSON.stringify(normalized.trace),
    JSON.stringify(normalized.metadata),
    timestamp,
    timestamp,
    lastRefreshedAt,
  );
  return normalized.observationKey;
}

export function getObservation(owner, observationKey) {
  owner.ensureOpen();
  const normalizedObservationKey = normalizeText(observationKey).toLowerCase();
  if (!normalizedObservationKey) {
    return null;
  }
  const row = owner.db.prepare(`
    SELECT
      observation_key, domain_key, title, prompt, focus, summary, confidence, scope,
      repository, freshness_hours, status, source, trace_json, metadata_json,
      created_at, updated_at, last_refreshed_at
    FROM refreshable_observation
    WHERE observation_key = ?
    LIMIT 1
  `).get(normalizedObservationKey);
  if (!row) {
    return null;
  }
  return mapObservationRow(row);
}

export function listObservations(owner, { repository, includeOtherRepositories = false, domainKey, scopes = [], status } = {}) {
  owner.ensureOpen();
  const repo = normalizeRepository(repository);
  const normalizedDomainKey = normalizeText(domainKey).toLowerCase() || null;
  const params = [];
  let sql = `
    SELECT
      observation_key, domain_key, title, prompt, focus, summary, confidence, scope,
      repository, freshness_hours, status, source, trace_json, metadata_json,
      created_at, updated_at, last_refreshed_at
    FROM refreshable_observation
    WHERE 1 = 1
  `;
  sql = applyScopeFilter(sql, params, repo, includeOtherRepositories);
  if (normalizedDomainKey) {
    sql += ` AND domain_key = ? `;
    params.push(normalizedDomainKey);
  }
  if (scopes.length > 0) {
    sql += ` AND scope IN (${scopes.map(() => "?").join(", ")}) `;
    params.push(...scopes);
  }
  if (status) {
    sql += ` AND status = ? `;
    params.push(normalizeText(status).toLowerCase());
  }
  sql += ` ORDER BY updated_at DESC, observation_key ASC `;
  return owner.db.prepare(sql).all(...params).map(mapObservationRow);
}

export function deleteGeneratedSemanticMemories(owner, sessionId) {
  owner.ensureOpen();
  owner.db.prepare(`
    DELETE FROM semantic_memory
    WHERE source_session_id = ?
      AND COALESCE(json_extract(metadata_json, '$.source'), '') NOT IN ('memory_save', 'lore_retain', 'onboarding', 'pi', 'pi:command')
      AND COALESCE(scope_source, 'auto') != 'manual'
  `).run(sessionId);
}
