/**
 * lib/lifecycle/session-lifecycle.mjs
 *
 * Host-agnostic pieces of the session lifecycle that Copilot (extension.mjs),
 * the Pi worker (lore-server-runtime.mjs), and the native CLI hosts
 * (lib/clients/cli-runtime.mjs — Codex/Claude/Antigravity) each re-implement
 * around their own protocol shapes.
 *
 * This module intentionally does NOT try to unify every lifecycle step.
 * Session-start/prompt-submit recall assembly and Copilot's own
 * onPostToolUse/onErrorOccurred handling stay in their hosts: each already
 * differs in ordering, gating, and caching in ways that are load-bearing for
 * that host, and collapsing them here would risk silent behaviour changes.
 * See the refactor report for the full step-by-step inventory.
 *
 * What *is* safely shared (identical steps, currently copy-pasted across the
 * CLI and Pi hosts):
 *   - onSessionCapture: extractSessionMemories -> reconcileCaptureEvidence ->
 *     applySessionExtraction (or reconcileGeneratedMemories when a host wants
 *     to skip applying on an empty turn window).
 */

import { extractSessionMemories } from "../sessions/rule-extractor.mjs";
import { applySessionExtraction } from "../sessions/backfill.mjs";
import { reconcileCaptureEvidence } from "../clients/cli-capture-evidence.mjs";

/**
 * Extract, reconcile, and apply (or skip) generated memories for one
 * captured transcript window. Shared by the CLI capture callback and the Pi
 * archive/session extraction callback, which perform this exact sequence
 * with only source-tagging and empty-turn handling differing per host.
 *
 * @param {object} options
 * @param {object} options.db - LoreDb instance.
 * @param {string} options.sessionId
 * @param {string|null} options.repository
 * @param {object} options.config - Lore config (passed to extractSessionMemories).
 * @param {object} options.artifacts - Session artifacts (session/turns/etc.).
 * @param {object|null} [options.workspace] - Workspace context passed to
 *   extraction. Defaults to `{ workspace: { repository, updated_at } }`.
 * @param {string|null} [options.source] - Overrides episodeDigest.source
 *   (e.g. `rule:${client}:${revision}`) when a host wants source
 *   traceability; left at extractSessionMemories' own default otherwise.
 * @param {boolean} [options.skipApplyWhenNoTurns] - When true and
 *   artifacts.turns is empty, retire evidence via
 *   db.reconcileGeneratedMemories instead of applying the (empty) episode
 *   via applySessionExtraction.
 * @returns {{ captureState: { cleanupCursor: *, branchWork: * }, extraction: object }}
 */
export function onSessionCapture({
  db,
  sessionId,
  repository,
  config,
  artifacts,
  workspace = null,
  source = null,
  skipApplyWhenNoTurns = false,
}) {
  const resolvedWorkspace = workspace ?? {
    workspace: { repository, updated_at: artifacts.session.updated_at },
  };
  const extraction = extractSessionMemories({
    sessionId,
    repository,
    sessionArtifacts: artifacts,
    workspace: resolvedWorkspace,
    config,
  });
  if (source) {
    extraction.episodeDigest.source = source;
  }
  const captureState = reconcileCaptureEvidence({ db, sessionId, artifacts, extraction });
  if (skipApplyWhenNoTurns && artifacts.turns.length === 0) {
    db.reconcileGeneratedMemories({
      sessionId,
      repository,
      memories: [],
      retiredEvidenceKeys: extraction.retiredEvidenceKeys,
    });
  } else {
    applySessionExtraction({
      db,
      sessionId,
      repository,
      sessionArtifacts: artifacts,
      workspace: resolvedWorkspace,
      extraction,
    });
  }
  return { captureState, extraction };
}
