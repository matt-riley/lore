import { parseJsonArray } from "../utils/json-array-utils.mjs";
import { parseJsonObject } from "../utils/json-object-utils.mjs";
import { clampInteger } from "../utils/numeric-utils.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { buildSemanticEligibilitySql } from "./db-retrieval-policy.mjs";
import { nowIso } from "./db-shared.mjs";

export function listActiveStabilisationMemories(owner, {
  repository,
  includeGlobal = true,
  limit = 50,
} = {}) {
  owner.ensureOpen();
  const repo = normalizeRepository(repository);
  const eligibility = buildSemanticEligibilitySql({
    alias: "",
    repository: repo,
    includeOtherRepositories: false,
  });
  return owner.db.prepare(`
    SELECT
      id,
      type,
      content,
      scope,
      repository,
    confidence,
    updated_at,
      expires_at,
    source_session_id,
    metadata_json
    FROM semantic_memory
    WHERE ${eligibility.sql}
      AND type IN ('open_loop', 'assistant_goal')
      ${includeGlobal ? "" : "AND scope = 'repo'"}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(
    ...eligibility.params,
    clampInteger(limit, 50, { min: 1, max: 200 }),
  ).map((row) => ({
    ...row,
    metadata: parseJsonObject(row.metadata_json),
  }));
}

export function listMemoryHygieneEpisodes(owner, {
  repository,
  includeOtherRepositories = true,
  limit = 100,
} = {}) {
  owner.ensureOpen();
  const repo = normalizeRepository(repository);
  const boundedLimit = clampInteger(limit, 100, { min: 1, max: 500 });
  const mapRows = (rows) => rows.map((row) => ({
    sessionId: row.session_id,
    scope: row.scope,
    repository: row.repository,
    summary: row.summary,
    actions: parseJsonArray(row.actions_json),
    decisions: parseJsonArray(row.decisions_json),
    openItems: parseJsonArray(row.open_items_json),
    updatedAt: row.updated_at,
  }));
  const selectSql = `
    SELECT
      session_id,
      scope,
      repository,
      summary,
      actions_json,
      decisions_json,
      open_items_json,
      updated_at
    FROM episode_digest
  `;
  if (!includeOtherRepositories) {
    return mapRows(owner.db.prepare(`
      ${selectSql}
      WHERE IFNULL(repository, '') = IFNULL(?, '')
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(repo, boundedLimit));
  }

  const primaryLimit = Math.max(1, Math.ceil(boundedLimit / 2));
  const otherLimit = Math.max(0, boundedLimit - primaryLimit);
  const primaryRows = owner.db.prepare(`
    ${selectSql}
    WHERE IFNULL(repository, '') = IFNULL(?, '')
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(repo, primaryLimit);
  const otherRows = otherLimit > 0
    ? owner.db.prepare(`
        ${selectSql}
        WHERE IFNULL(repository, '') != IFNULL(?, '')
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(repo, otherLimit)
    : [];
  return mapRows([...primaryRows, ...otherRows]);
}

// Marker prefix -> the forgetMemory actor that would have written a matching
// memory_suppression row for it, so restore can undo exactly that (never a
// manual forget, an unrelated automated run, or an earlier legacy row).
// extractor-revalidation markers never insert a suppression row in the first
// place (see db-extraction-revalidation.mjs), so their suppression cleanup
// below is simply a no-op.
const RESTORABLE_MARKER_ACTORS = Object.freeze({
  "auto-hygiene:": "memory_hygiene",
  "extractor-revalidation:": "extraction_revalidation",
});

export function restoreMemoriesBySupersessionMarker(owner, marker) {
  owner.ensureOpen();
  const normalizedMarker = String(marker ?? "").trim();
  const prefix = Object.keys(RESTORABLE_MARKER_ACTORS).find((candidate) => normalizedMarker.startsWith(candidate));
  if (!prefix) {
    throw new Error("marker must start with auto-hygiene: or extractor-revalidation:");
  }
  const actor = RESTORABLE_MARKER_ACTORS[prefix];
  const rows = owner.db.prepare(`
    SELECT id
    FROM semantic_memory
    WHERE superseded_by = ?
    ORDER BY id
  `).all(normalizedMarker);
  if (rows.length === 0) {
    return [];
  }
  const restore = () => {
    owner.db.prepare(`
      UPDATE semantic_memory
      SET superseded_by = NULL, updated_at = ?
      WHERE superseded_by = ?
    `).run(nowIso(), normalizedMarker);
    // Only suppressions written by this exact run are reversed; a manual
    // forget (different actor/reason, or an earlier legacy row) keeps
    // blocking retrieval.
    const deleteSuppression = owner.db.prepare(`
      DELETE FROM memory_suppression
      WHERE memory_id = ? AND actor = ? AND reason = ?
    `);
    for (const row of rows) {
      deleteSuppression.run(row.id, actor, normalizedMarker);
    }
  };
  if (typeof owner.withSemanticMemoryTransaction === "function") {
    owner.withSemanticMemoryTransaction(restore);
  } else {
    restore();
  }
  return rows.map((row) => row.id);
}
