import { buildScopeEligibilitySql } from "./db-retrieval-policy.mjs";

export function nowIso() {
  return new Date().toISOString();
}

export const SCOPE_SOURCE = Object.freeze({
  AUTO: "auto",
  MANUAL: "manual",
});

export function normalizeScopeSource(value, fallback = SCOPE_SOURCE.AUTO) {
  return value === SCOPE_SOURCE.MANUAL ? SCOPE_SOURCE.MANUAL : fallback;
}

export function applyScopeFilter(sql, params, repo, includeOtherRepositories, alias = "") {
  const policy = buildScopeEligibilitySql({
    alias: alias || "",
    repository: repo,
    includeOtherRepositories,
  });
  params.push(...policy.params);
  return `${sql} AND (${policy.sql}) `;
}
