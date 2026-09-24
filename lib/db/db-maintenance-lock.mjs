import { nowIso } from "./db-shared.mjs";

/**
 * A tiny singleton-row mutex used to keep exactly one background maintenance
 * sweep running at a time across processes that share the same Lore
 * database (native CLI hook children, the Pi worker, cron/launchd runs).
 *
 * Unlike the deferred-extraction lease (per-job, heartbeat-renewed), this is
 * a single named lock ("scope") with a fixed lease duration. Acquisition and
 * expiry-checking happen in one atomic UPDATE...ON CONFLICT statement, so
 * SQLite's own writer serialization is what makes two concurrent acquirers
 * resolve to exactly one winner — no separate reclaim pass is needed.
 */

/**
 * Ensure the maintenance_lock table exists. Additive side table, created
 * idempotently on first use (same pattern as ensureMemoryEmbeddingTable in
 * db-embedding.mjs) rather than through a schema version bump: a bump
 * migrates every database opened by this checkout immediately, including a
 * user's live one, and then reopening that same database from a build that
 * predates this table would refuse it as an "unsupported future schema
 * version". A lazily-created side table has none of that blast radius.
 *
 * No-op on a read-only connection — `PRAGMA query_only` blocks writes, and
 * acquire/release below already return before reaching here in that case;
 * this guard is defense in depth for any other caller.
 */
export function ensureMaintenanceLockTable(owner) {
  owner.ensureOpen();
  if (owner.readOnly) {
    return;
  }
  owner.db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_lock (
      scope TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
}

export function acquireMaintenanceLock(owner, {
  scope = "background",
  ownerToken,
  leaseDurationMs = 5 * 60 * 1000,
} = {}) {
  owner.ensureOpen();
  if (!ownerToken) {
    throw new Error("acquireMaintenanceLock requires an ownerToken");
  }
  if (owner.readOnly) {
    return false;
  }
  ensureMaintenanceLockTable(owner);
  const acquiredAt = nowIso();
  const numericLeaseDurationMs = Number(leaseDurationMs);
  const boundedLeaseDurationMs = Number.isFinite(numericLeaseDurationMs)
    ? Math.max(1000, numericLeaseDurationMs)
    : 5 * 60 * 1000;
  const expiresAt = new Date(Date.now() + boundedLeaseDurationMs).toISOString();
  const result = owner.db.prepare(`
    INSERT INTO maintenance_lock (scope, owner_token, acquired_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      owner_token = excluded.owner_token,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
    WHERE maintenance_lock.expires_at <= excluded.acquired_at
  `).run(String(scope), String(ownerToken), acquiredAt, expiresAt);
  return result.changes > 0;
}

export function releaseMaintenanceLock(owner, {
  scope = "background",
  ownerToken,
} = {}) {
  owner.ensureOpen();
  if (!ownerToken || owner.readOnly) {
    return;
  }
  ensureMaintenanceLockTable(owner);
  owner.db.prepare(`
    DELETE FROM maintenance_lock WHERE scope = ? AND owner_token = ?
  `).run(String(scope), String(ownerToken));
}
