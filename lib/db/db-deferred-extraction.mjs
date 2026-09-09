import { normalizeRepository } from "../utils/repository-utils.mjs";
import { nowIso } from "./db-shared.mjs";

export function enqueueDeferredExtraction(owner, {
  sessionId,
  repository,
  reason = "manual",
  priority = 0,
  delayMinutes = 0,
  metadata = {},
}) {
  owner.ensureOpen();
  const queuedAt = nowIso();
  const availableAt = new Date(Date.now() + (delayMinutes * 60 * 1000)).toISOString();
  owner.db.prepare(`
    INSERT INTO deferred_extraction (
      session_id, repository, status, priority, reason, queued_at, available_at, metadata_json
    ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      repository = excluded.repository,
      status = CASE
        WHEN deferred_extraction.status = 'running' THEN deferred_extraction.status
        ELSE 'pending'
      END,
      priority = CASE
        WHEN excluded.priority > deferred_extraction.priority THEN excluded.priority
        ELSE deferred_extraction.priority
      END,
      reason = excluded.reason,
      queued_at = excluded.queued_at,
      available_at = CASE
        WHEN deferred_extraction.status = 'running' THEN deferred_extraction.available_at
        ELSE excluded.available_at
      END,
      last_error = NULL,
      metadata_json = excluded.metadata_json
  `).run(
    sessionId,
    normalizeRepository(repository),
    priority,
    reason,
    queuedAt,
    availableAt,
    JSON.stringify(metadata),
  );
}

export function listDeferredExtractions(owner, { repository, limit = 2 }) {
  owner.ensureOpen();
  const repo = normalizeRepository(repository);
  const now = nowIso();
  if (repo) {
    return owner.db.prepare(`
      SELECT session_id, repository, status, priority, reason, queued_at, available_at, attempts, last_error, metadata_json
      FROM deferred_extraction
      WHERE repository = ?
        AND status IN ('pending', 'failed')
        AND available_at <= ?
      ORDER BY priority DESC, available_at ASC, queued_at ASC
      LIMIT ?
    `).all(repo, now, limit);
  }
  return owner.db.prepare(`
    SELECT session_id, repository, status, priority, reason, queued_at, available_at, attempts, last_error, metadata_json
    FROM deferred_extraction
    WHERE status IN ('pending', 'failed')
      AND available_at <= ?
    ORDER BY priority DESC, available_at ASC, queued_at ASC
    LIMIT ?
  `).all(now, limit);
}

export function markDeferredExtractionRunning(owner, sessionId) {
  owner.ensureOpen();
  owner.db.prepare(`
    UPDATE deferred_extraction
    SET status = 'running',
        attempts = attempts + 1,
        started_at = ?,
        last_error = NULL
    WHERE session_id = ?
  `).run(nowIso(), sessionId);
}

/**
 * Atomically claim a pending/failed deferred extraction job for exclusive
 * processing.  Returns true when the job was successfully claimed by this
 * caller, false when another worker already holds it or the job is not
 * available (e.g. not yet due).
 *
 * The claim sets a 10-minute lease (configurable via leaseDurationMs) that
 * must be renewed every ≤2 minutes via heartbeatDeferredExtraction.  If the
 * lease expires, reclaimStaleDeferredExtractions will reset the job to
 * "failed" so another worker can pick it up.
 *
 * @param {string} sessionId
 * @param {string} ownerToken - Opaque token identifying the claiming worker
 * @param {number} [leaseDurationMs=600000] - Lease TTL in milliseconds (default 10 min)
 * @returns {boolean} true when claimed, false when already held or unavailable
 */
export function claimDeferredExtraction(owner, sessionId, ownerToken, leaseDurationMs = 10 * 60 * 1000) {
  owner.ensureOpen();
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
  const result = owner.db.prepare(`
    UPDATE deferred_extraction
    SET status = 'running',
        attempts = attempts + 1,
        started_at = ?,
        owner_token = ?,
        lease_expires_at = ?,
        heartbeat_at = ?,
        last_error = NULL
    WHERE session_id = ?
      AND status IN ('pending', 'failed')
      AND available_at <= ?
  `).run(now, ownerToken, leaseExpiresAt, now, sessionId, now);
  return result.changes > 0;
}

/**
 * Renew the lease for an active deferred extraction job.  Only succeeds when
 * the caller still owns the job (owner_token matches) and the job is still
 * in "running" state.
 *
 * Must be called at least once per 10-minute lease window; a 2-minute
 * heartbeat interval keeps the lease well within its expiry.
 *
 * @param {string} sessionId
 * @param {string} ownerToken
 * @param {number} [leaseDurationMs=600000] - Renewed lease TTL (default 10 min)
 * @returns {boolean} true when renewed, false when the lease is already lost
 */
export function heartbeatDeferredExtraction(owner, sessionId, ownerToken, leaseDurationMs = 10 * 60 * 1000) {
  owner.ensureOpen();
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
  const result = owner.db.prepare(`
    UPDATE deferred_extraction
    SET heartbeat_at = ?,
        lease_expires_at = ?
    WHERE session_id = ?
      AND owner_token = ?
      AND status = 'running'
  `).run(now, leaseExpiresAt, sessionId, ownerToken);
  return result.changes > 0;
}

/**
 * Reclaim running deferred extraction jobs that are no longer making
 * progress. Lease-aware jobs are reclaimed when their lease expires; legacy
 * rows without lease metadata are reclaimed after the bounded stale window.
 * Resets each to "failed" so the next processing cycle can retry it.
 *
 * @param {{ staleAfterMs?: number }} [options]
 * @returns {number} Number of jobs reclaimed
 */
export function reclaimStaleDeferredExtractions(owner, { staleAfterMs = 30 * 60 * 1000 } = {}) {
  owner.ensureOpen();
  const now = nowIso();
  const numericStaleAfterMs = Number(staleAfterMs);
  const boundedStaleAfterMs = Number.isFinite(numericStaleAfterMs)
    ? Math.max(1, numericStaleAfterMs)
    : 30 * 60 * 1000;
  const staleCutoff = new Date(Date.now() - boundedStaleAfterMs).toISOString();
  const result = owner.db.prepare(`
    UPDATE deferred_extraction
    SET status = 'failed',
        last_error = CASE
          WHEN lease_expires_at IS NOT NULL AND lease_expires_at < ?
            THEN 'lease expired'
          ELSE 'stale running job reclaimed'
        END,
        available_at = ?,
        completed_at = NULL,
        owner_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL
    WHERE status = 'running'
      AND (
        (lease_expires_at IS NOT NULL AND lease_expires_at < ?)
        OR (
          lease_expires_at IS NULL
          AND COALESCE(started_at, queued_at) IS NOT NULL
          AND COALESCE(started_at, queued_at) < ?
        )
      )
  `).run(now, now, now, staleCutoff);
  return result.changes;
}

export function completeDeferredExtraction(owner, sessionId, ownerToken = null) {
  owner.ensureOpen();
  const completedAt = nowIso();
  const row = owner.db.prepare(`
    SELECT repository
    FROM deferred_extraction
    WHERE session_id = ?
    LIMIT 1
  `).get(sessionId);
  // When an ownerToken is provided, guard against stale workers completing
  // a job that has already been reclaimed by another caller.  Without a
  // token (legacy callers), behave as before.
  const result = ownerToken
    ? owner.db.prepare(`
        UPDATE deferred_extraction
        SET status = 'completed',
            completed_at = ?,
            last_error = NULL
        WHERE session_id = ?
          AND owner_token = ?
          AND status = 'running'
      `).run(completedAt, sessionId, ownerToken)
    : owner.db.prepare(`
        UPDATE deferred_extraction
        SET status = 'completed',
            completed_at = ?,
            last_error = NULL
        WHERE session_id = ?
      `).run(completedAt, sessionId);
  // Only update activity state when the completion actually landed.
  if (!ownerToken || result.changes > 0) {
    owner.upsertActivitySuccess({
      repository: row?.repository ?? null,
      updates: {
        lastExtractionCompletionAt: completedAt,
        lastExtractionRepository: row?.repository ?? null,
      },
    });
    owner.upsertActivitySuccess({
      repository: null,
      updates: {
        lastExtractionCompletionAt: completedAt,
        lastExtractionRepository: row?.repository ?? null,
      },
    });
  }
}

export function failDeferredExtraction(owner, sessionId, { errorMessage, retryDelayMinutes = 15, ownerToken = null }) {
  owner.ensureOpen();
  const availableAt = new Date(Date.now() + (retryDelayMinutes * 60 * 1000)).toISOString();
  // Guard by ownerToken when provided so a stale worker cannot clobber the
  // state of a job that has already been reclaimed by a new worker.
  if (ownerToken) {
    owner.db.prepare(`
      UPDATE deferred_extraction
      SET status = 'failed',
          available_at = ?,
          last_error = ?,
          owner_token = NULL,
          lease_expires_at = NULL
      WHERE session_id = ?
        AND owner_token = ?
        AND status = 'running'
    `).run(availableAt, errorMessage, sessionId, ownerToken);
  } else {
    owner.db.prepare(`
      UPDATE deferred_extraction
      SET status = 'failed',
          available_at = ?,
          last_error = ?
      WHERE session_id = ?
    `).run(availableAt, errorMessage, sessionId);
  }
}
