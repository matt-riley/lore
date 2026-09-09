import crypto from "node:crypto";
import { nowIso } from "./db-shared.mjs";

/**
 * Persist a privacy-minimised error telemetry record.
 * Accepts only categorical fields — never raw messages or stacks.
 *
 * @param {{ sessionId: string | null, contextCategory: string, recoverability: string, fingerprint: string }} record
 * @returns {string} Generated record ID.
 */
export function insertErrorTelemetry(owner, { sessionId, contextCategory, recoverability, fingerprint }) {
  owner.ensureOpen();
  const id = crypto.randomUUID();
  owner.db.prepare(`
    INSERT INTO error_telemetry (id, session_id, context_category, recoverability, fingerprint, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sessionId ?? null,
    String(contextCategory || "unknown"),
    String(recoverability || "unknown"),
    String(fingerprint || ""),
    nowIso(),
  );
  return id;
}

/**
 * Prune old error telemetry rows for retention compliance.
 * Deletes rows older than maxAgeMs and trims to maxRowsGlobal.
 *
 * @param {{ maxRowsGlobal?: number, maxAgeMs?: number }} options
 * @returns {{ deletedByAge: number, deletedByLimit: number }}
 */
export function pruneErrorTelemetry(owner, {
  maxRowsGlobal = 500,
  maxAgeMs = 30 * 24 * 60 * 60 * 1000,
} = {}) {
  owner.ensureOpen();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const byAge = owner.db.prepare(
    `DELETE FROM error_telemetry WHERE created_at < ?`,
  ).run(cutoff);
  const byLimit = owner.db.prepare(`
    DELETE FROM error_telemetry WHERE id NOT IN (
      SELECT id FROM error_telemetry ORDER BY created_at DESC LIMIT ?
    )
  `).run(maxRowsGlobal);
  return {
    deletedByAge: byAge.changes ?? 0,
    deletedByLimit: byLimit.changes ?? 0,
  };
}
