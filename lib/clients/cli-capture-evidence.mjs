import { createHash } from "node:crypto";

/** Reconcile source revisions independently of the rolling extraction window. */
export function reconcileCaptureEvidence({ db, sessionId, artifacts, extraction }) {
  const generation = artifacts.captureGeneration;
  const currentKeys = new Set(extraction.semanticMemories.map((memory) => memory.evidence?.key).filter(Boolean));
  const retired = new Set(extraction.retiredEvidenceKeys ?? []);
  for (const memory of extraction.semanticMemories) {
    if (memory.evidence) {
      memory.evidence.sourceIdentity = artifacts.sourceIdentity;
      memory.evidence.metadata = { ...memory.evidence.metadata, captureGeneration: generation };
    }
  }
  const bySource = db.db.prepare("SELECT evidence_key, revision FROM session_evidence WHERE session_id = ? AND source_record_id = ? AND retired_at IS NULL");
  const markObserved = db.db.prepare("UPDATE session_evidence SET metadata_json = json_set(metadata_json, '$.captureGeneration', ?) WHERE evidence_key = ?");
  const abandoned = new Set(artifacts.retiredSourceRecordIds ?? []);
  const branchWork = reconcileClaudeGraph({ db, sessionId, artifacts, abandoned });
  const captureNodeRevisions = new Map(db.db.prepare("SELECT metadata_json FROM session_evidence WHERE session_id = ? AND source_kind = 'capture_node'")
    .all(sessionId).flatMap((row) => {
      try {
        const metadata = JSON.parse(row.metadata_json || "{}");
        return metadata.sourceRecordId && metadata.sourceRevision ? [[String(metadata.sourceRecordId), metadata.sourceRevision]] : [];
      } catch { return []; }
    }));
  for (const source of artifacts.observedSources ?? []) {
    for (const old of bySource.all(sessionId, source.source_record_id)) {
      if (old.revision === source.source_revision && !abandoned.has(source.source_record_id)) markObserved.run(generation, old.evidence_key);
      else if (!currentKeys.has(old.evidence_key)) retired.add(old.evidence_key);
    }
  }
  for (const id of abandoned) {
    for (const old of bySource.all(sessionId, id)) {
      if (currentKeys.has(old.evidence_key)) continue;
      // Only branch retirement is reversible by selecting that branch again.
      // Preserve exactly the links that were active, not earlier revisions or
      // proposition corrections sharing this source record.
      if (artifacts.activeLeafUuid) {
        const links = db.db.prepare("SELECT memory_id FROM memory_evidence WHERE evidence_key = ? AND retired_at IS NULL")
          .all(old.evidence_key).map((row) => row.memory_id);
        const metadata = (() => { try { return JSON.parse(old.metadata_json || "{}"); } catch { return {}; } })();
        metadata.captureBranchLinks = links;
        const nodeRevision = captureNodeRevisions.get(String(id));
        if (nodeRevision) metadata.captureNodeRevision = nodeRevision;
        db.db.prepare("UPDATE session_evidence SET metadata_json = ? WHERE evidence_key = ?")
          .run(JSON.stringify(metadata), old.evidence_key);
      }
      retired.add(old.evidence_key);
    }
  }
  // A completed rescan may need several bounded ledger pages. Unknown legacy
  // provenance is preserved; only records previously managed by this reader
  // can be proved absent from this source generation.
  let cleanupCursor = artifacts.captureCleanupCursor ?? null;
  if (artifacts.resetComplete) cleanupCursor = "";
  if (cleanupCursor !== null) {
    const rows = db.db.prepare(`SELECT evidence_key, metadata_json FROM session_evidence
      WHERE session_id = ? AND evidence_key > ? ORDER BY evidence_key LIMIT 128`).all(sessionId, cleanupCursor);
    for (const row of rows) {
      const oldGeneration = JSON.parse(row.metadata_json || "{}").captureGeneration;
      if (oldGeneration && oldGeneration !== generation && !currentKeys.has(row.evidence_key)) retired.add(row.evidence_key);
    }
    cleanupCursor = rows.length === 128 ? rows.at(-1).evidence_key : null;
  }
  extraction.retiredEvidenceKeys = [...retired];
  return { cleanupCursor, branchWork };
}


// Text-free graph records live in the evidence ledger, so an arbitrarily old
// branch can be reconciled without putting its history back in the checkpoint.
function reconcileClaudeGraph({ db, sessionId, artifacts, abandoned }) {
  const key = (uuid) => `capture-node:claude:${sessionId}:${uuid}`;
  const get = db.db.prepare("SELECT metadata_json FROM session_evidence WHERE evidence_key = ?");
  const put = db.db.prepare(`INSERT INTO session_evidence (evidence_key, session_id, repository,
    source_identity, source_record_id, source_kind, revision, proposition_fingerprint, content_hash,
    metadata_json, captured_at) VALUES (?, ?, ?, ?, ?, 'capture_node', ?, ?, ?, ?, ?)
    ON CONFLICT(evidence_key) DO UPDATE SET revision=excluded.revision, metadata_json=excluded.metadata_json,
      content_hash=excluded.content_hash, retired_at=NULL`);
  let previous = artifacts.previousLeafUuid;
  let forked = false;
  for (const record of artifacts.claudeRecords ?? []) {
    const oldRow = get.get(key(record.uuid));
    const old = oldRow ? JSON.parse(oldRow.metadata_json) : null;
    if (old && old.sourceRecordId !== record.sourceRecordId) abandoned.add(old.sourceRecordId);
    if (previous && record.parentUuid !== previous && record.uuid !== previous) forked = true;
    previous = record.uuid;
    const metadata = { ...record, captureGeneration: artifacts.captureGeneration };
    const hash = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
    put.run(key(record.uuid), sessionId, artifacts.session.repository, artifacts.sourceIdentity, record.uuid, record.sourceRevision,
      hash, hash, JSON.stringify(metadata), new Date().toISOString());
  }
  let work = artifacts.branchWork;
  if (forked && artifacts.previousLeafUuid) work = {
    phase: "mark", cursor: artifacts.activeLeafUuid, oldLeaf: artifacts.previousLeafUuid,
    epoch: createHash("sha256").update(`${artifacts.captureGeneration}:${artifacts.activeLeafUuid}:${artifacts.claudeRecords.at(-1)?.sourceRecordId}`).digest("hex"),
  };
  const mark = db.db.prepare("UPDATE session_evidence SET metadata_json = ? WHERE evidence_key = ?");
  for (let count = 0; work && count < 128; count += 1) {
    const row = work.cursor ? get.get(key(work.cursor)) : null;
    const node = row ? JSON.parse(row.metadata_json) : null;
    if (work.phase === "mark") {
      if (!node || node.activeEpoch === work.epoch) { work = { ...work, phase: "retire", cursor: work.oldLeaf }; continue; }
      // An unchanged earlier sibling may have no text left in the bounded
      // checkpoint. Its already-extracted evidence can be restored from the
      // ledger only when this source generation proves the node active again.
      const evidenceRows = db.db.prepare(`SELECT evidence_key, metadata_json FROM session_evidence
        WHERE session_id = ? AND source_record_id = ? AND retired_at IS NOT NULL`)
        .all(sessionId, node.sourceRecordId);
      for (const evidence of evidenceRows) {
        const metadata = JSON.parse(evidence.metadata_json || "{}");
        if (node.captureGeneration !== artifacts.captureGeneration
          || typeof node.sourceRevision !== "string"
          || metadata.captureNodeRevision !== node.sourceRevision
          || !Array.isArray(metadata.captureBranchLinks)) continue;
        db.db.prepare("UPDATE session_evidence SET retired_at = NULL, metadata_json = json_remove(metadata_json, '$.captureBranchLinks') WHERE evidence_key = ?")
          .run(evidence.evidence_key);
        for (const memoryId of metadata.captureBranchLinks) {
          db.db.prepare(`UPDATE memory_evidence SET retired_at = NULL WHERE evidence_key = ? AND memory_id = ?
            AND EXISTS (SELECT 1 FROM semantic_memory WHERE id = ? AND superseded_by IS NULL)`)
            .run(evidence.evidence_key, memoryId, memoryId);
        }
      }
      node.activeEpoch = work.epoch;
      mark.run(JSON.stringify(node), key(work.cursor));
      work = { ...work, cursor: node.parentUuid };
    } else {
      if (!node || node.activeEpoch === work.epoch || node.retiredEpoch === work.epoch) { work = null; break; }
      abandoned.add(node.sourceRecordId);
      node.retiredEpoch = work.epoch;
      mark.run(JSON.stringify(node), key(work.cursor));
      work = { ...work, cursor: node.parentUuid };
    }
  }
  return work;
}
