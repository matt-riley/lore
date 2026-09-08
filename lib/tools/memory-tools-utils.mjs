const IMPROVEMENT_STATUSES = new Map([
  ["resolved", "resolved"],
  ["superseded", "superseded"],
]);

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function ensureStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeImprovementStatus(value) {
  return IMPROVEMENT_STATUSES.get(value) ?? "active";
}

export function ensureString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

export function ensureLimit(value, fallback, max = 50) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(max, Math.floor(value));
  }
  return fallback;
}

export function ensureIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("ids must be a non-empty array");
  }
  const ids = [...new Set(
    value
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  )];
  if (ids.length === 0) {
    throw new Error("ids must contain at least one non-empty string");
  }
  return ids;
}

export function ensureObject(value, fieldName) {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

export function readOptionalTrimmedString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readOptionalLowercaseString(value) {
  const normalized = readOptionalTrimmedString(value);
  return normalized ? normalized.toLowerCase() : undefined;
}

export function resolveRepositoryArg(value, runtimeRepository) {
  return readOptionalTrimmedString(value) ?? runtimeRepository;
}

export function formatRows(rows, render) {
  if (!rows || rows.length === 0) {
    return "No results.";
  }
  return rows.map(render).join("\n");
}

export function formatImprovementArtifactRows(rows) {
  return formatRows(rows, (row) => {
    const evidenceKeys = Object.keys(row.evidence ?? {});
    return [
      `- [${row.id}] ${row.source_kind}:${row.source_case_id}`,
      `status=${row.status}`,
      `title=${row.title}`,
      `summary=${row.summary}`,
      `linkedMemory=${row.linked_memory_id ?? "none"}`,
      `created=${row.created_at}`,
      `updated=${row.updated_at}`,
      row.resolved_at ? `resolved=${row.resolved_at}` : null,
      row.superseded_by ? `supersededBy=${row.superseded_by}` : null,
      row.proposal_path ? `proposal=${row.proposal_path}` : null,
      row.review_state && row.review_state !== "none" ? `reviewState=${row.review_state}` : null,
      evidenceKeys.length > 0 ? `evidenceKeys=${evidenceKeys.join(",")}` : null,
    ].filter(Boolean).join(" ");
  });
}

export function normalizeRetainContext(args, runtime) {
  return {
    kind: args.kind === "workstream" ? "workstream" : "semantic",
    repository: typeof args.repository === "string" && args.repository.trim().length > 0
      ? args.repository.trim()
      : runtime.repository,
    scope: typeof args.scope === "string" ? args.scope.trim() : undefined,
    domainKey: typeof args.domainKey === "string" && args.domainKey.trim().length > 0
      ? args.domainKey.trim().toLowerCase()
      : null,
  };
}

export function formatLoreUnavailable(runtime) {
  if (runtime.initialized && !runtime.lastError) {
    return null;
  }
  return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
}
