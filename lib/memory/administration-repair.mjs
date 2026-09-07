import { readAdministrationSource, parseAdministrationTranscript, readCopilotRepairSource } from "./administration-source.mjs";
import { extractSessionMemories } from "../sessions/rule-extractor.mjs";
import { normalizeEvidence, isExplicitLifecycleWrite } from "../db/db-memory-lifecycle.mjs";
import { collectRetiredDecisionEvidenceKeys } from "../sessions/decision-subject.mjs";
import { collectRetiredDirectiveEvidenceKeys } from "../sessions/directive-corrections.mjs";
import { resolveRepositoryIdentity } from "../utils/repository-identity.mjs";
import { hash, object } from "./administration-rows.mjs";

const sameProposition = (a, b) => a.type === b.type && a.content.trim().toLowerCase() === b.content.trim().toLowerCase() && a.scope === b.scope && (a.repository ?? null) === (b.repository ?? null);

export function buildRepairPlan(owner, request, rows) {
  const candidates = [], unresolved = [], sources = [], suppressionKeys = new Set();
  if (request.repositoryMappings.length) return { candidates, unresolved, sources, suppressionKeys: [...suppressionKeys] };
  for (const sessionId of rows.sessions) {
    try {
      const checkpoint = (rows.tables.ingestion_checkpoint ?? []).find((row) => row.session_id === sessionId);
      const state = object(checkpoint?.adapter_state_json);
      let artifacts, fingerprint;
      const knownRepositories = [...new Set(rows.memories.filter((row) => row.source_session_id === sessionId && row.repository).map((row) => row.repository))];
      let repository = checkpoint?.repository ?? (rows.tables.episode_digest ?? []).find((row) => row.session_id === sessionId)?.repository ?? request.repository ?? (knownRepositories.length === 1 ? knownRepositories[0] : null);
      if (checkpoint && state.sourcePath) {
        const source = readAdministrationSource(state.sourcePath);
        fingerprint = source.fingerprint;
        artifacts = parseAdministrationTranscript(source.bytes, { client: checkpoint.client, sessionId, repository, cwd: state.sourceCwd, timestamp: new Date(fingerprint.mtimeMs).toISOString() });
      } else {
        const source = readCopilotRepairSource(owner.config, sessionId);
        artifacts = source.artifacts;
        fingerprint = source.fingerprint;
        repository ??= resolveRepositoryIdentity({ cwd: artifacts.session.cwd, legacy: artifacts.session.repository, mappings: owner.getRepositoryMappings() });
      }
      sources.push({ sessionId, ...fingerprint, complete: true });
      if (!repository && artifacts.turns.length) throw new Error("SOURCE_REPOSITORY_UNRESOLVED");
      // Extract every complete-source window. No absence decision uses only the
      // final twenty turns. Overlap preserves conversation reversal context.
      const proposed = new Map(), retired = new Set();
      const ends = artifacts.turns.length ? Array.from({ length: Math.ceil(artifacts.turns.length / 10) }, (_, index) => Math.min(artifacts.turns.length, (index + 1) * 10)) : [0];
      for (const end of ends) {
        const extraction = extractSessionMemories({ sessionId, repository, sessionArtifacts: { ...artifacts, turns: artifacts.turns.slice(Math.max(0, end - 20), end) }, workspace: { workspace: { repository, updated_at: artifacts.session.updated_at } }, config: owner.config });
        for (const key of extraction.retiredEvidenceKeys ?? []) retired.add(key);
        for (const memory of extraction.semanticMemories ?? []) {
          const evidence = normalizeEvidence({ sessionId, repository, memory });
          memory.evidence = { ...memory.evidence, sourceIdentity: fingerprint.sourceIdentity };
          const suppressed = owner.findActiveSuppression(owner.buildSemanticMemoryWriteContext(memory, "2026-01-01T00:00:00.000Z"));
          if (suppressed) suppressionKeys.add(suppressed.suppression_key);
          else proposed.set(evidence.key, memory);
        }
      }
      for (const key of [...collectRetiredDecisionEvidenceKeys([...proposed.values()]), ...collectRetiredDirectiveEvidenceKeys([...proposed.values()], artifacts.turns)]) retired.add(key);
      for (const key of retired) proposed.delete(key);
      const targets = rows.memories.filter((memory) => memory.source_session_id === sessionId || (rows.tables.memory_evidence ?? []).some((link) => link.memory_id === memory.id && (rows.tables.session_evidence ?? []).some((evidence) => evidence.evidence_key === link.evidence_key && evidence.session_id === sessionId)));
      const retireMemoryIds = [], retiredLinks = [], retiredEvidenceKeys = new Set();
      for (const old of targets) {
        if (old.superseded_by || isExplicitLifecycleWrite(old, object(old.metadata_json))) continue;
        const links = owner.listSemanticEvidence(old.id).filter((link) => !link.retiredAt && !link.linkRetiredAt && link.sessionId === sessionId);
        if (![...proposed.values()].some((memory) => sameProposition(old, memory))) {
          // Other sessions can still support this row: retire only this source.
          for (const link of links) {
            if (proposed.has(link.key)) retiredLinks.push({ memoryId: old.id, evidenceKey: link.key });
            else retiredEvidenceKeys.add(link.key);
          }
          const foreign = owner.listSemanticEvidence(old.id).some((link) => !link.retiredAt && !link.linkRetiredAt && link.sessionId !== sessionId);
          if (!foreign) retireMemoryIds.push(old.id);
        } else {
          // Legacy source IDs are replaced only after a complete source scan.
          for (const link of links) if (!proposed.has(link.key)) retiredEvidenceKeys.add(link.key);
        }
      }
      // Only selected source evidence is retired; unrelated sessions stay intact.
      for (const key of retired) if ((rows.tables.session_evidence ?? []).some((row) => row.evidence_key === key)) retiredEvidenceKeys.add(key);
      const memories = [...proposed.values()].filter((memory) => {
        const evidence = normalizeEvidence({ sessionId, repository, memory });
        const current = owner.db.prepare("SELECT * FROM session_evidence WHERE evidence_key=?").get(evidence.key);
        const linked = owner.db.prepare("SELECT sm.* FROM memory_evidence me JOIN semantic_memory sm ON sm.id=me.memory_id WHERE me.evidence_key=? AND me.retired_at IS NULL AND sm.superseded_by IS NULL").all(evidence.key);
        return !current || current.retired_at || current.revision !== evidence.revision || !linked.some((old) => sameProposition(old, memory));
      });
      if (!memories.length && !retireMemoryIds.length && !retiredEvidenceKeys.size && !retiredLinks.length) continue;
      if (memories.length + retireMemoryIds.length + retiredEvidenceKeys.size + retiredLinks.length > request.limit) throw new Error("SOURCE_CANDIDATE_BOUND_REACHED");
      const destinationIds = new Set();
      for (const memory of memories) {
        const write = owner.buildSemanticMemoryWriteContext(memory, "2026-01-01T00:00:00Z");
        for (const match of [owner.findManualSemanticMemoryMatch(memory, write.canonicalKey, write.scope, write.repository), owner.findScopedSemanticMemoryMatch(memory, write.canonicalKey, write.scope, write.repository)]) if (match?.id) destinationIds.add(match.id);
        for (const row of owner.db.prepare("SELECT memory_id FROM memory_evidence WHERE evidence_key=? AND retired_at IS NULL LIMIT ?").all(memory.evidence.key, request.limit + 1)) destinationIds.add(row.memory_id);
      }
      if (destinationIds.size > request.limit) throw new Error("SOURCE_CANDIDATE_BOUND_REACHED");
      const destinationRows = [...destinationIds].sort().map((id) => owner.db.prepare("SELECT * FROM semantic_memory WHERE id=?").get(id)).filter(Boolean);
      const destinationEvidence = [...destinationIds].sort().flatMap((id) => owner.listSemanticEvidence(id));
      if (destinationEvidence.length > request.limit) throw new Error("SOURCE_CANDIDATE_BOUND_REACHED");
      const action = { sessionId, repository, memories, retireMemoryIds, retiredLinks, retiredEvidenceKeys: [...retiredEvidenceKeys].sort(), destinationRows, destinationEvidence };
      candidates.push({ candidateId: `repair:${hash(action)}`, action: "reextract_source", ...action });
    } catch (error) {
      unresolved.push({ code: /^SOURCE_[A-Z_]+$/.test(error.message) ? error.message : "SOURCE_UNAVAILABLE", selector: sessionId, detail: "A complete validated source is required; no missing-window evidence was inferred." });
    }
  }
  if (!rows.sessions.length && rows.memories.some((row) => !isExplicitLifecycleWrite(row, object(row.metadata_json)))) unresolved.push({ code: "SOURCE_UNAVAILABLE", selector: rows.memories.map((row) => row.id) });
  return { candidates, unresolved, sources, suppressionKeys: [...suppressionKeys] };
}

export function applyRepairPlan(owner, candidates, selected) {
  const repairedIds = new Set();
  for (const candidate of candidates) {
    if (!selected.has(candidate.candidateId)) continue;
    for (const id of candidate.retireMemoryIds) {
      const row = owner.db.prepare("SELECT * FROM semantic_memory WHERE id=?").get(id);
      if (row && !isExplicitLifecycleWrite(row, object(row.metadata_json))) owner.db.prepare("UPDATE semantic_memory SET superseded_by=?, updated_at=? WHERE id=? AND superseded_by IS NULL").run(candidate.candidateId, new Date().toISOString(), id);
    }
    const timestamp = new Date().toISOString();
    for (const link of candidate.retiredLinks) owner.db.prepare("UPDATE memory_evidence SET retired_at=? WHERE memory_id=? AND evidence_key=?").run(timestamp, link.memoryId, link.evidenceKey);
    for (const memory of candidate.memories) {
      // An explicitly selected complete-source repair may reactivate validated
      // generated evidence. Suppressed proposals never enter this action.
      owner.db.prepare("UPDATE session_evidence SET retired_at=NULL WHERE evidence_key=?").run(memory.evidence.key);
    }
    const linked = owner.reconcileGeneratedMemories({ sessionId: candidate.sessionId, repository: candidate.repository, memories: candidate.memories, retiredEvidenceKeys: candidate.retiredEvidenceKeys });
    for (const id of linked) if (id) repairedIds.add(id);
  }
  return [...repairedIds];
}
