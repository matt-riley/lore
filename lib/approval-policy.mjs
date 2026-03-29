/**
 * approval-policy.mjs — persisted local approval substrate.
 *
 * Records and resolves per-action-family approval decisions scoped to an
 * optional repository and optional target identity.  Decisions are stored
 * in the `action_approval` table and are resolved at call time using a
 * simple precedence ladder:
 *
 *   target-identity-scoped (most specific)
 *     → repository-scoped
 *       → global (most general)
 *
 * No tool surface is wired here.  This module is internal-only so that
 * future consumer slices can adopt it without changing the substrate.
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const APPROVAL_DECISION = Object.freeze({
  ASK: "ask",
  ALLOW: "allow",
  DENY: "deny",
});

/** Known action families — extend as new mutable actions are introduced. */
export const APPROVAL_FAMILY = Object.freeze({
  MEMORY_WRITE: "memory_write",
  MEMORY_DELETE: "memory_delete",
  SCOPE_OVERRIDE: "scope_override",
  PROPOSAL_APPLY: "proposal_apply",
  IMPROVEMENT_RESOLVE: "improvement_resolve",
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function isExpired(row) {
  return row.expires_at != null && row.expires_at < nowIso();
}

function normalizeDecision(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === APPROVAL_DECISION.ALLOW) return APPROVAL_DECISION.ALLOW;
  if (v === APPROVAL_DECISION.DENY) return APPROVAL_DECISION.DENY;
  return APPROVAL_DECISION.ASK;
}

function rowToApproval(row) {
  return {
    id: row.id,
    actionFamily: row.action_family,
    repository: row.repository ?? null,
    targetIdentity: row.target_identity ?? null,
    decision: row.decision,
    durable: row.durable === 1,
    reason: row.reason ?? null,
    grantedBy: row.granted_by,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// resolveApproval
// ---------------------------------------------------------------------------

/**
 * Resolve the effective approval decision for an action.
 *
 * Resolution order (first non-expired live row wins):
 *   1. action_family + repository + target_identity  (most specific)
 *   2. action_family + repository                    (repo scope)
 *   3. action_family only                            (global)
 *
 * If no stored decision exists the effective decision is "ask".
 *
 * @param {object} db             - Live LoreDatabase instance
 * @param {object} options
 * @param {string} options.actionFamily    - One of APPROVAL_FAMILY values
 * @param {string|null} [options.repository]    - Current repository or null
 * @param {string|null} [options.targetIdentity] - Specific target or null
 * @returns {{ decision: string, source: string, approval: object|null }}
 */
export function resolveApproval(db, { actionFamily, repository = null, targetIdentity = null } = {}) {
  if (typeof actionFamily !== "string" || actionFamily.trim().length === 0) {
    throw new Error("actionFamily must be a non-empty string");
  }

  const candidates = db.db.prepare(`
    SELECT * FROM action_approval
    WHERE action_family = ?
      AND (repository IS NULL OR repository = ?)
      AND (target_identity IS NULL OR target_identity = ?)
    ORDER BY
      CASE WHEN target_identity IS NOT NULL THEN 0
           WHEN repository IS NOT NULL THEN 1
           ELSE 2 END,
      updated_at DESC
  `).all(actionFamily, repository ?? null, targetIdentity ?? null);

  // Specificity tiers: prefer identity-scoped, then repo-scoped, then global
  const tiers = [
    (r) => r.target_identity === (targetIdentity ?? null) && r.repository === (repository ?? null),
    (r) => r.target_identity === null && r.repository === (repository ?? null) && repository != null,
    (r) => r.target_identity === null && r.repository === null,
  ];

  for (const tier of tiers) {
    const match = candidates.find((r) => tier(r) && !isExpired(r));
    if (match) {
      return {
        decision: match.decision,
        source: match.target_identity != null
          ? "target"
          : match.repository != null
            ? "repository"
            : "global",
        approval: rowToApproval(match),
      };
    }
  }

  return { decision: APPROVAL_DECISION.ASK, source: "default", approval: null };
}

// ---------------------------------------------------------------------------
// recordApproval
// ---------------------------------------------------------------------------

/**
 * Persist an approval decision for a given action family + scope.
 *
 * If a non-expired, non-durable row with the same (actionFamily, repository,
 * targetIdentity) already exists it is updated in place.  Durable rows are
 * never updated by this path — call revokeApproval first if you need to
 * replace a durable grant.
 *
 * @param {object} db
 * @param {object} options
 * @param {string}  options.actionFamily
 * @param {string|null} [options.repository]
 * @param {string|null} [options.targetIdentity]
 * @param {string}  options.decision         - "ask" | "allow" | "deny"
 * @param {boolean} [options.durable=false]  - Survive session restart
 * @param {string|null} [options.reason]
 * @param {string}  [options.grantedBy="user"]
 * @param {string|null} [options.expiresAt]  - ISO timestamp or null
 * @returns {string} The persisted approval id
 */
export function recordApproval(db, {
  actionFamily,
  repository = null,
  targetIdentity = null,
  decision,
  durable = false,
  reason = null,
  grantedBy = "user",
  expiresAt = null,
} = {}) {
  if (typeof actionFamily !== "string" || actionFamily.trim().length === 0) {
    throw new Error("actionFamily must be a non-empty string");
  }
  const normalizedDecision = normalizeDecision(decision);
  const now = nowIso();

  // Look for an existing non-durable row at the same specificity level.
  const existing = db.db.prepare(`
    SELECT id, durable, expires_at FROM action_approval
    WHERE action_family = ?
      AND (repository IS ? OR (repository IS NULL AND ? IS NULL))
      AND (target_identity IS ? OR (target_identity IS NULL AND ? IS NULL))
    LIMIT 1
  `).get(
    actionFamily,
    repository ?? null, repository ?? null,
    targetIdentity ?? null, targetIdentity ?? null,
  );

  if (existing && !isExpired(existing) && existing.durable !== 1) {
    db.db.prepare(`
      UPDATE action_approval
      SET decision = ?, durable = ?, reason = ?, granted_by = ?, expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      normalizedDecision,
      durable ? 1 : 0,
      reason ?? null,
      grantedBy,
      expiresAt ?? null,
      now,
      existing.id,
    );
    return existing.id;
  }

  const id = crypto.randomUUID();
  db.db.prepare(`
    INSERT INTO action_approval
      (id, action_family, repository, target_identity, decision, durable, reason, granted_by, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    actionFamily,
    repository ?? null,
    targetIdentity ?? null,
    normalizedDecision,
    durable ? 1 : 0,
    reason ?? null,
    grantedBy,
    expiresAt ?? null,
    now,
    now,
  );
  return id;
}

// ---------------------------------------------------------------------------
// revokeApproval
// ---------------------------------------------------------------------------

/**
 * Revoke an approval by id.  Hard-deletes the row so it no longer
 * influences resolution.
 *
 * @param {object} db
 * @param {string} id - The approval id to revoke
 * @returns {boolean} true if a row was deleted, false if not found
 */
export function revokeApproval(db, id) {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("id must be a non-empty string");
  }
  const result = db.db.prepare(`DELETE FROM action_approval WHERE id = ?`).run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// listApprovals
// ---------------------------------------------------------------------------

/**
 * List stored approvals, optionally filtered.
 * Expired rows are included; callers may filter by expiresAt if needed.
 *
 * @param {object} db
 * @param {object} [options]
 * @param {string|null} [options.actionFamily]   - Filter by family or null for all
 * @param {string|null} [options.repository]     - Filter by repo or null for all
 * @returns {object[]} Array of approval objects
 */
export function listApprovals(db, { actionFamily = null, repository = null } = {}) {
  let sql = `SELECT * FROM action_approval WHERE 1=1`;
  const params = [];

  if (actionFamily != null) {
    sql += ` AND action_family = ?`;
    params.push(actionFamily);
  }
  if (repository != null) {
    sql += ` AND repository = ?`;
    params.push(repository);
  }

  sql += ` ORDER BY action_family, updated_at DESC`;
  return db.db.prepare(sql).all(...params).map(rowToApproval);
}

// ---------------------------------------------------------------------------
// purgeExpiredApprovals
// ---------------------------------------------------------------------------

/**
 * Delete all expired approval rows.  Safe to call periodically during
 * maintenance without affecting live decisions.
 *
 * @param {object} db
 * @returns {number} Number of rows removed
 */
export function purgeExpiredApprovals(db) {
  const now = nowIso();
  const result = db.db.prepare(`
    DELETE FROM action_approval WHERE expires_at IS NOT NULL AND expires_at < ?
  `).run(now);
  return result.changes;
}
