/**
 * extraction-revalidation.mjs
 *
 * Rule-extracted semantic memories (lib/sessions/rule-extractor.mjs, using
 * the grammar in lib/sessions/extraction-grammar.mjs) are classified once, at
 * extraction time. The grammar keeps improving; a row written by an older
 * version of it stays active forever unless something replays the current
 * grammar against it. This module is that replay: a pure function that takes
 * a stored generated memory row and decides whether the current grammar
 * would still produce it, produce a different type for it, or produce
 * nothing at all.
 *
 * No I/O here. lib/db/db-extraction-revalidation.mjs owns querying rows (a
 * row counts as rule-extracted when metadata.source is 'rule_extractor', OR
 * metadata.source is absent and the row still carries a source_turn_index,
 * source_session_id, and scope_source of 'auto' -- every real pre-existing
 * rule-extracted row has metadata_json of `{}` or `{"originRepository":...}`,
 * with no `source` key at all, since source-stamping was added after they
 * were written; see that module's doc comment for the full rationale), and
 * lib/memory/extraction-revalidation.mjs owns applying verdicts and rollback.
 */
import {
  isHypotheticalDirectiveSentence,
  isNonDirectiveSentence,
  isOneOffDirectiveRequest,
  EXPLICIT_PREFERENCE_PATTERNS,
  EXPLICIT_REJECTION_PATTERNS,
  splitChainedOneOffClause,
  splitDirectiveClauses,
  splitSentences,
  standingDirectiveType,
} from "./extraction-grammar.mjs";
import { EXTRACTOR_VERSION, hasExplicitDirective, isWellFormedMistakeClause } from "./rule-extractor.mjs";
import { classifySemanticMemory, MEMORY_SCOPE } from "../memory/memory-scope.mjs";

export { EXTRACTOR_VERSION };

// Sources the current rule-extractor's standing-directive grammar produces,
// plus recurring_mistake (replayed against the clause-shape grammar in
// isWellFormedMistakeClause instead of classifyStandingContent below). Other
// rule-extractor output (decisions, identity, interaction style, open loops)
// is built from different heuristics and is out of scope for this replay.
const CANDIDATE_TYPES = Object.freeze(["user_preference", "rejected_approach", "directive", "recurring_mistake"]);

const RECURRING_MISTAKE_PREFIX = "Recurring mistake to avoid: ";

// Rows written before metadata.mistake was stamped (or written by the
// implicit-correction inference, which never carries the raw clause) fall
// back to stripping the stable content template.
function extractMistakeText(row, metadata, content) {
  if (typeof metadata.mistake === "string" && metadata.mistake) {
    return metadata.mistake;
  }
  return content.startsWith(RECURRING_MISTAKE_PREFIX)
    ? content.slice(RECURRING_MISTAKE_PREFIX.length)
    : content;
}

// Explicit/manual write sources (see isExplicitLifecycleWrite in
// db-memory-lifecycle.mjs) must never be touched by an automated revalidation
// pass -- only rows the grammar itself generated are candidates.
const MANUAL_WRITE_SOURCES = new Set(["memory_save", "lore_retain", "onboarding", "pi", "pi:command"]);

function isManualOrExplicitRow({ metadata = {}, scopeSource, scope_source: legacyScopeSource } = {}) {
  const resolvedScopeSource = scopeSource ?? legacyScopeSource;
  return resolvedScopeSource === "manual" || MANUAL_WRITE_SOURCES.has(metadata?.source);
}

/**
 * Replay the standing-directive grammar against a bare content string, using
 * the same entry points extractDirectiveMemoriesFromTurn uses for a single
 * user message: sentence split, chained one-off trimming, non-directive /
 * hypothetical / one-off filtering, the semicolon-incident guard, and the
 * explicit preference/rejection/standing-directive classifiers.
 *
 * Returns the set of standing types (a subset of "user_preference",
 * "directive", "rejected_approach") the current grammar would recognize in
 * this content. An empty set means the grammar no longer recognizes it as a
 * standing directive at all.
 */
export function classifyStandingContent(content) {
  const types = new Set();
  for (const splitSentence of splitSentences(content, { splitSemicolons: false })) {
    const chainedOneOff = splitChainedOneOffClause(splitSentence);
    const rawSentence = chainedOneOff ? chainedOneOff.lead : splitSentence;
    if (isNonDirectiveSentence(rawSentence, { allowConditions: true })
      || isHypotheticalDirectiveSentence(rawSentence)
      || isOneOffDirectiveRequest(rawSentence)) {
      continue;
    }
    const clauses = splitDirectiveClauses(rawSentence);
    if (rawSentence.includes(";")
      && !hasExplicitDirective(clauses[0], EXPLICIT_PREFERENCE_PATTERNS)
      && !hasExplicitDirective(clauses[0], EXPLICIT_REJECTION_PATTERNS)
      && standingDirectiveType(clauses[0]) !== "directive") {
      continue;
    }
    for (const clause of clauses) {
      if (hasExplicitDirective(clause, EXPLICIT_PREFERENCE_PATTERNS)) {
        types.add("user_preference");
      } else if (standingDirectiveType(clause) === "directive") {
        types.add("directive");
      }
      if (hasExplicitDirective(clause, EXPLICIT_REJECTION_PATTERNS)) {
        types.add("rejected_approach");
      }
    }
  }
  return types;
}

function normalizeRowMetadata(row) {
  return row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
}

/**
 * A global-scoped row whose current classification would no longer be global
 * is demoted to repo scope (using the origin repository the row's metadata
 * or its own repository column already carries) or, lacking an origin,
 * rejected outright. Shared by every candidate type once its own grammar has
 * confirmed the row's content/type is still recognized.
 *
 * @returns {object|null} a demote/reject verdict, or null if no change is needed.
 */
function evaluateScopeDemotion(row, metadata, content) {
  if (row.scope !== MEMORY_SCOPE.GLOBAL) {
    return null;
  }
  const classification = classifySemanticMemory({
    type: row.type,
    content,
    repository: null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    metadata,
  });
  if (classification.scope === MEMORY_SCOPE.GLOBAL) {
    return null;
  }
  const originRepository = metadata.originRepository ?? row.repository ?? null;
  if (originRepository) {
    return {
      verdict: "demote",
      targetScope: MEMORY_SCOPE.REPO,
      targetRepository: originRepository,
      reason: "global_scope_no_longer_supported",
    };
  }
  return { verdict: "reject", reason: "global_scope_no_longer_supported_no_origin" };
}

/**
 * Decide what should happen to one stored generated semantic-memory row
 * under the current grammar.
 *
 * @param {object} row - { id, type, content, scope, repository, metadata,
 *   scopeSource | scope_source, tags }
 * @returns {{ verdict: "keep"|"reject"|"reclassify"|"demote", reason: string,
 *   reclassifiedType?: string, targetScope?: string, targetRepository?: (string|null) }}
 */
export function revalidateGeneratedMemory(row) {
  const metadata = normalizeRowMetadata(row);

  if (isManualOrExplicitRow({ metadata, scopeSource: row?.scopeSource, scope_source: row?.scope_source })) {
    return { verdict: "keep", reason: "manual_write_excluded" };
  }
  if (!CANDIDATE_TYPES.includes(row?.type)) {
    return { verdict: "keep", reason: "unsupported_type" };
  }
  if (metadata.source && metadata.source !== "rule_extractor") {
    return { verdict: "keep", reason: "not_rule_extracted" };
  }
  const storedVersion = typeof metadata.extractorVersion === "string" ? metadata.extractorVersion : null;
  if (storedVersion && storedVersion >= EXTRACTOR_VERSION) {
    return { verdict: "keep", reason: "current_extractor_version" };
  }

  const content = typeof row?.content === "string" ? row.content : "";

  if (row.type === "recurring_mistake") {
    const mistake = extractMistakeText(row, metadata, content);
    if (!isWellFormedMistakeClause(mistake)) {
      return { verdict: "reject", reason: "recurring_mistake_no_longer_well_formed" };
    }
    return evaluateScopeDemotion(row, metadata, content) ?? { verdict: "keep", reason: "still_matches_current_grammar" };
  }

  const recognizedTypes = classifyStandingContent(content);
  if (recognizedTypes.size === 0) {
    return { verdict: "reject", reason: "no_longer_matches_grammar" };
  }
  if (!recognizedTypes.has(row.type)) {
    return {
      verdict: "reclassify",
      reclassifiedType: [...recognizedTypes][0],
      reason: "type_reclassified_by_grammar",
    };
  }

  return evaluateScopeDemotion(row, metadata, content) ?? { verdict: "keep", reason: "still_matches_current_grammar" };
}
