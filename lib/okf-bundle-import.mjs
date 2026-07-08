const OKF_IMPORT_TYPE = "okf_concept";
const OKF_IMPORT_SOURCE = "memory_okf_import";
const DEFAULT_OKF_IMPORT_CONFIDENCE = 0.7;

/**
 * Pure: maps OKF concepts (as produced by readOkfBundle()) into
 * semantic-memory-shaped objects ready for retainMemory({kind: "semantic"}).
 * No I/O and no db access -- callers own persistence and counting.
 *
 * Imported concepts are tagged/typed distinctly from self-authored memory
 * (memory_save) and default to a lower confidence, since this is externally
 * sourced content the assistant did not verify itself. type=okf_concept
 * carries a stable canonical key (repository::conceptId) so re-importing an
 * unchanged or edited bundle upserts/reinforces existing rows instead of
 * duplicating them (see memory-scope.mjs buildSemanticCanonicalKey).
 */
export function buildOkfImportMemories({ concepts, repository, confidence, sourceSessionId } = {}) {
  const list = Array.isArray(concepts) ? concepts : [];
  const resolvedConfidence = typeof confidence === "number" ? confidence : DEFAULT_OKF_IMPORT_CONFIDENCE;
  return list.map((concept) => buildOkfImportMemory({
    concept,
    repository,
    confidence: resolvedConfidence,
    sourceSessionId,
  }));
}

function buildOkfImportMemory({ concept, repository, confidence, sourceSessionId }) {
  const okfConceptKey = `${repository ?? "global"}::${concept.id}`;
  const content = [concept.title, concept.description, concept.body]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  const tags = [...new Set([concept.type, "okf_import", ...(Array.isArray(concept.tags) ? concept.tags : [])].filter(Boolean))];

  return {
    type: OKF_IMPORT_TYPE,
    content,
    confidence,
    repository: repository ?? null,
    tags,
    sourceSessionId,
    metadata: {
      source: OKF_IMPORT_SOURCE,
      okfConceptKey,
      okfId: concept.id,
      resource: concept.resource ?? null,
      timestamp: concept.timestamp ?? null,
    },
  };
}

/** Formats the memory_portable_bundle action=import result string. */
export function formatOkfImportResult({
  bundleDir,
  repository,
  importedCount = 0,
  skippedCount = 0,
  totalConceptCount = 0,
}) {
  return [
    "action: import",
    "format: okf",
    `bundlePath: ${bundleDir ?? "unknown"}`,
    `repository: ${repository ?? "global"}`,
    `conceptsFound: ${totalConceptCount}`,
    `importedCount: ${importedCount}`,
    `skippedCount: ${skippedCount}`,
    "",
    "Notes:",
    "- imported concepts are stored as type=okf_concept, tagged okf_import, at a lower default confidence (0.7) than self-authored memory",
    "- re-importing the same bundle reinforces existing rows (confidence/tags/reinforcement) instead of duplicating them, but stored content is not overwritten by a later import -- the first import's content wins",
    "- retrieve imported concepts via memory_search(type=\"okf_concept\")",
    "- to revert a bad import: memory_search(type=\"okf_concept\") to list rows, then memory_forget(id=..., supersededBy=\"reverted okf import\") per row",
  ].filter(Boolean).join("\n");
}
