import { MEMORY_SCOPE } from "../memory/memory-scope.mjs";
import crypto from "node:crypto";

const MANUAL_SOURCES = new Set(["memory_save", "lore_retain", "onboarding"]);

function resolvedNow(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && Number.isFinite(Date.parse(now))) return new Date(now).toISOString();
  return new Date().toISOString();
}

export function isValidExpiry(value) {
  return value === null || value === undefined || (
    typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))
  );
}

export function isManualMemoryRow(row) {
  let metadata = row?.metadata;
  if ((!metadata || typeof metadata !== "object") && typeof row?.metadata_json === "string") {
    try { metadata = JSON.parse(row.metadata_json); } catch { metadata = {}; }
  }
  const source = metadata?.source ?? row?.metadata_source ?? row?.source;
  return row?.scope_source === "manual" || row?.scopeSource === "manual" || MANUAL_SOURCES.has(source);
}

export function isSemanticMemoryRowEligible(row, {
  repository = null,
  includeOtherRepositories = false,
  now = new Date(),
  suppressionIds = null,
  suppressionRows = null,
} = {}) {
  if (!row || (row.superseded_by ?? row.supersededBy)) return { eligible: false, reason: "superseded" };
  const expiry = row.expires_at ?? row.expiresAt ?? null;
  if (!isValidExpiry(expiry)) return { eligible: false, reason: "invalid_expiry" };
  if (expiry !== null && Date.parse(expiry) <= Date.parse(resolvedNow(now))) {
    return { eligible: false, reason: "expired" };
  }
  const rowRepository = row.repository || null;
  const scope = row.scope || MEMORY_SCOPE.REPO;
  if (!includeOtherRepositories) {
    if (!repository && !(scope === MEMORY_SCOPE.GLOBAL && !rowRepository)) {
      return { eligible: false, reason: "unknown_repository_scope" };
    }
    if (repository && !(
      (scope === MEMORY_SCOPE.GLOBAL && !rowRepository)
      || (rowRepository === repository)
    )) {
      return { eligible: false, reason: "repository_scope" };
    }
  }
  if (!isManualMemoryRow(row)) {
    const metadata = typeof row.metadata_json === "string" ? (() => {
      try { return JSON.parse(row.metadata_json); } catch { return {}; }
    })() : row.metadata ?? {};
    const evidence = metadata?.evidence ?? {};
    const canonical = row.canonical_key
      ? crypto.createHash("sha256").update([row.type ?? "", row.canonical_key ?? ""].join("\0")).digest("hex")
      : null;
    const evidenceValues = [
      evidence.key,
      evidence.contentHash,
      evidence.propositionFingerprint,
      !row.canonical_key ? contentFingerprint(row.type, row.content) : null,
    ].filter((value) => typeof value === "string" && value.length > 0)
      .flatMap((value) => [value, isSha256(value) ? value : hash(value)]);
    const suppressed = (suppressionIds && row.id && suppressionIds.has(row.id))
      || (Array.isArray(suppressionRows) && suppressionRows.some((entry) => (
        entry.scope === (row.scope ?? MEMORY_SCOPE.REPO)
        && (entry.repository || null) === (row.repository || null)
        && (entry.memory_id === row.id || (canonical && entry.canonical_fingerprint === canonical)
          || evidenceValues.includes(entry.evidence_fingerprint))
      )));
    if (suppressed) return { eligible: false, reason: "suppressed" };
  }
  return { eligible: true, reason: null };
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/iu.test(String(value ?? ""));
}

function contentFingerprint(type, content) {
  return hash([type ?? "", content ?? ""].join("\0"));
}

/**
 * SQL policy for semantic memory reads. The caller may append type, FTS and
 * ordering predicates after this fragment. The first parameter is `now`.
 */
export function buildSemanticEligibilitySql({
  alias = "sm",
  repository = null,
  includeOtherRepositories = false,
  now = new Date(),
} = {}) {
  const column = (name) => `${alias}.${name}`;
  const params = [resolvedNow(now)];
  let scopeSql;
  if (includeOtherRepositories) {
    // Explicit cross-repository searches decide their own scope via `scopes`.
    // This keeps memory_search's historical all-scope behavior intact.
    scopeSql = "1 = 1";
  } else if (repository) {
    params.push(repository);
    scopeSql = `((${column("scope")} = '${MEMORY_SCOPE.GLOBAL}' AND (${column("repository")} IS NULL OR ${column("repository")} = '')) OR ${column("repository")} = ?)`;
  } else {
    scopeSql = `(${column("scope")} = '${MEMORY_SCOPE.GLOBAL}' AND (${column("repository")} IS NULL OR ${column("repository")} = ''))`;
  }
  return {
    sql: `${column("superseded_by")} IS NULL
      AND (${column("expires_at")} IS NULL OR julianday(${column("expires_at")}) > julianday(?))
      AND ${scopeSql}
      AND (
        COALESCE(${column("scope_source")}, 'auto') = 'manual'
        OR COALESCE(json_extract(${column("metadata_json")}, '$.source'), '') IN ('memory_save', 'lore_retain', 'onboarding')
        OR NOT EXISTS (
          SELECT 1 FROM memory_suppression policy_ms
          WHERE policy_ms.superseded_at IS NULL
            AND COALESCE(policy_ms.repair_candidate, 0) = 0
            AND policy_ms.memory_id = ${column("id")}
        )
      )
      AND (
        COALESCE(${column("scope_source")}, 'auto') = 'manual'
        OR COALESCE(json_extract(${column("metadata_json")}, '$.source'), '') IN ('memory_save', 'lore_retain', 'onboarding')
        OR NOT EXISTS (SELECT 1 FROM memory_evidence policy_me WHERE policy_me.memory_id = ${column("id")})
        OR EXISTS (
          SELECT 1 FROM memory_evidence policy_me
          JOIN session_evidence policy_se ON policy_se.evidence_key = policy_me.evidence_key
          WHERE policy_me.memory_id = ${column("id")}
            AND policy_me.retired_at IS NULL AND policy_se.retired_at IS NULL
        )
      )`,
    params,
  };
}

export function buildScopeEligibilitySql({ alias = "row", repository = null, includeOtherRepositories = false } = {}) {
  const col = (name) => `${alias ? `${alias}.` : ""}${name}`;
  if (includeOtherRepositories) return { sql: "1 = 1", params: [] };
  if (repository) return {
    sql: `((${col("scope")} = '${MEMORY_SCOPE.GLOBAL}' AND (${col("repository")} IS NULL OR ${col("repository")} = '')) OR ${col("repository")} = ?)`,
    params: [repository],
  };
  return { sql: `(${col("scope")} = '${MEMORY_SCOPE.GLOBAL}' AND (${col("repository")} IS NULL OR ${col("repository")} = ''))`, params: [] };
}

export { MANUAL_SOURCES };
