import { detectPromptContextNeed } from "./prompt-need.mjs";
import { renderPromptContext } from "./prompt-context-render.mjs";
import { assembleMemoryCapsule } from "./capsule-assembler.mjs";
import { recallHasQueryEvidence } from "./recall-query-evidence.mjs";
import { enforceSectionBudget, filterTraceIncludedRows, sectionsFromRenderedText } from "./output-budget.mjs";
import {
  findRelevantWorkstreamOverlays,
} from "./workstream-overlays.mjs";
import { buildOnboardingSection } from "../memory/onboarding.mjs";
import {
  readDirectivesEnabled,
  readMemoryOperationsEnabled,
} from "../rollout/rollout-flags.mjs";
import { normalizeText } from "../utils/text-normalizer.mjs";
import { estimateTokens } from "../utils/token-estimator.mjs";
import {
  compressContextWithLocalInference,
  expandRetrievalQueryWithLocalInference,
} from "../inference/local-inference-augmentation.mjs";
import { semanticSearch, semanticSearchEnabled } from "../memory/semantic-search.mjs";
import { redactSensitiveContent } from "../memory/memory-sensitivity.mjs";
import { rerankMemories } from "../inference/typesafe-rerank.mjs";
import { FEATURE_PROMPT_VERSION, minDurability, persistMemoryFeatures, scoreMemoryFeatures, typesafeFeaturesEnabled } from "../inference/typesafe-features.mjs";
import { hasExplicitGlobalScope } from "../memory/memory-scope.mjs";

export { detectPromptContextNeed } from "./prompt-need.mjs";

export const REQUIRED_RECALL_TITLES = [
  /^Lore Onboarding$/i,
  /^Standing Directives$/i,
  /^Response Style And Addressing$/i,
  /^(?:Relevant )?Commitments, Preferences, And Identity$/i,
];

export const PROMPT_RECALL_PHASES = Object.freeze({
  procedural: false,
  proposals: false,
  onboarding: true,
  directives: true,
  workstream: true,
});

export const SESSION_START_PHASES = Object.freeze({
  procedural: true,
  proposals: true,
  onboarding: false,
  directives: false,
  workstream: false,
});

const MANUAL_MEMORY_SOURCES = new Set(["memory_save", "lore_retain", "onboarding", "pi", "pi:command"]);

function isManualMemory(row) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return row?.scope_source === "manual" || MANUAL_MEMORY_SOURCES.has(metadata.source);
}

/** Ambient means deliberately global or explicitly written, not merely repo-scoped. */
function isAmbientDirectiveEligible(row) {
  if (row?.type !== "directive") {
    return false;
  }
  if (isManualMemory(row)) {
    return true;
  }
  if (row.scope !== "global") {
    return false;
  }
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return Boolean(metadata.originRepository) || hasExplicitGlobalScope(row.content);
}

/** Auto-extracted repo rules need evidence in the current prompt to surface. */
function isPromptRelevantDirective(row) {
  return row?.type === "directive"
    && row.scope !== "global"
    && !isManualMemory(row);
}

// Standing directives are capped at six, so collect a wider candidate window
// first: durability filtering happens before the cap, otherwise dropped
// one-off rows would silently consume the budget.
const DIRECTIVE_CANDIDATE_LIMIT = 24;
const DIRECTIVE_LIMIT = 6;

function storedFeature(row, key) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const typesafe = metadata.typesafe && typeof metadata.typesafe === "object" ? metadata.typesafe : {};
  if (Number(typesafe.promptVersion) !== FEATURE_PROMPT_VERSION) {
    return null;
  }
  const value = Number(typesafe[key]);
  return Number.isFinite(value) ? value : null;
}

function storedDurability(row) {
  return storedFeature(row, "durability");
}

function storedSpecificity(row) {
  return storedFeature(row, "specificity");
}

/**
 * When more directives qualify than fit, prefer the specific ones: a vague
 * instruction spends a slot a concrete rule could use. Rows without a score
 * keep their place, so this is skipped unless every candidate has one — that
 * keeps ordering predictable and leaves the feature-off path untouched.
 */
function orderBySpecificity(rows, config) {
  if (!typesafeFeaturesEnabled(config) || rows.length < 2) {
    return rows;
  }
  if (rows.some((row) => storedSpecificity(row) === null)) {
    return rows;
  }
  return [...rows].sort((left, right) => storedSpecificity(right) - storedSpecificity(left));
}

// Only auto-extracted directives are filtered. Explicit preference and
// rejection sentences already carry a stated basis, and dropping a durable
// "never do this" costs more than keeping a stale one.
function isFilterableDirective(row) {
  return row?.type === "directive";
}

/**
 * A write that failed once very likely fails again while the store is locked or
 * read-only, so remember those ids per database handle and stop paying a
 * provider call on every prompt for them. The row keeps its in-memory judgment
 * for the current run; later runs treat it as unscored and keep it, which is
 * exactly what the feature did before it existed.
 */
const failedFeatureWrites = new WeakMap();

function failedWriteIds(db) {
  let ids = failedFeatureWrites.get(db);
  if (!ids) {
    ids = new Set();
    failedFeatureWrites.set(db, ids);
  }
  return ids;
}

/**
 * Score unscored directive candidates once, persist the features on the row,
 * then drop statements that are not durable rules. Fail-open: rows without a
 * feature and any scoring failure are kept, exactly as before this existed.
 */
async function filterDirectiveCandidates({ db, rows, config, fetchImpl }) {
  const trace = {
    enabled: false,
    reason: null,
    threshold: minDurability(config),
    scored: 0,
    dropped: 0,
    withheldSensitive: 0,
    model: null,
    error: null,
  };
  if (!typesafeFeaturesEnabled(config)) {
    trace.reason = "features_disabled";
    return { rows, trace };
  }
  trace.enabled = true;

  // Only directives are scored: they are the one consumer, and preferences and
  // rejections are exempt from filtering by design.
  const unscored = rows.filter((row) => isFilterableDirective(row)
    && storedDurability(row) === null
    && !failedWriteIds(db).has(row.id));
  if (unscored.length > 0) {
    let result = null;
    try {
      result = await scoreMemoryFeatures({ memories: unscored, config, fetchImpl });
    } catch (error) {
      // The module returns rather than throws today; this keeps the recall
      // fail-open even if that ever changes.
      trace.error = error instanceof Error ? error.message : String(error);
    }
    if (result) {
      trace.scored = result.features.length;
      trace.withheldSensitive = result.withheldSensitive ?? 0;
      trace.model = result.model ?? null;
      trace.error = result.error ?? null;
      const { saved, failed } = persistMemoryFeatures(db, result.features);
      trace.persisted = saved;
      if (failed.length > 0) {
        trace.persistFailures = (trace.persistFailures ?? 0) + failed.length;
        for (const id of failed) {
          failedWriteIds(db).add(id);
        }
      }
      for (const feature of result.features) {
        const annotation = {
          durability: feature.durability,
          specificity: feature.specificity,
          model: feature.model,
          promptVersion: feature.promptVersion,
          scoredAt: feature.scoredAt,
        };
        const row = rows.find((candidate) => candidate.id === feature.id);
        if (row) {
          row.metadata = {
            ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
            typesafe: annotation,
          };
        }
      }
      // A failed scoring pass still applies judgments already on disk, so the
      // filter below always runs.
      if (!result.applied && result.reason !== "no_memories") {
        trace.reason = `scoring_${result.reason}`;
      }
    } else {
      trace.reason = "scoring_unavailable";
    }
  }

  const kept = rows.filter((row) => {
    if (!isFilterableDirective(row)) {
      return true;
    }
    const durability = storedDurability(row);
    return durability === null || durability >= trace.threshold;
  });
  trace.reason = trace.reason ?? "durability_filtered";
  trace.dropped = rows.length - kept.length;
  return { rows: kept, trace };
}

async function fetchDirectives({ db, prompt, repository, includeOtherRepositories, config, fetchImpl }) {
  if (!readDirectivesEnabled(config)) {
    return { rows: [], text: "", trace: { enabled: false, reason: "directives_disabled" } };
  }
  const ambientRows = db.searchSemantic({
    query: "",
    repository,
    includeOtherRepositories,
    types: ["directive"],
    // Filter after retrieval so stale auto-global rows cannot consume the
    // six-row standing-directive budget before eligible rows are considered.
    limit: 50,
  }).filter(isAmbientDirectiveEligible);
  const directiveQuery = normalizeText(prompt);
  // Term-based relevance, not raw FTS: a prompt sharing only a scaffold word
  // ("should") with a stored rule must not resurrect that rule. This is the
  // scored fallback, not searchPromptSemanticRows (a bare query passthrough).
  const relevantRows = directiveQuery
    ? db.searchPromptSemanticFallback({
      prompt: directiveQuery,
      repository,
      includeOtherRepositories,
      types: ["directive"],
      limit: 50,
    }).filter(isPromptRelevantDirective)
    : [];
  const seen = new Set();
  const rows = [];
  for (const row of [...ambientRows, ...relevantRows]) {
    const key = row.id ?? normalizeText(row.content).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push(row);
    if (rows.length >= DIRECTIVE_CANDIDATE_LIMIT) {
      break;
    }
  }
  const filtered = await filterDirectiveCandidates({ db, rows, config, fetchImpl });
  const selected = orderBySpecificity(filtered.rows, config).slice(0, DIRECTIVE_LIMIT);
  const durability = filtered.trace;
  if (selected.length === 0) {
    return {
      rows: [],
      text: "",
      trace: { enabled: true, reason: "no_directives_found", rows: [], includedRows: [], durability },
    };
  }
  const lines = ["## Standing Directives", ""];
  for (const row of selected) {
    const content = normalizeText(row.content);
    if (content) {
      lines.push(`- ${content}`);
    }
  }
  return {
    rows: selected,
    text: lines.join("\n"),
    trace: {
      enabled: true,
      reason: "directives_included",
      count: selected.length,
      rows: selected,
      includedRows: selected,
      durability,
    },
  };
}

const RRF_K = 60;

export function fuseLexicalAndVector(lexicalRows = [], vectorRows = [], { k = RRF_K, limit = 6 } = {}) {
  const scores = new Map();
  const byId = new Map();
  const addRanking = (rows) => {
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      const id = row?.id;
      if (!id) {
        return;
      }
      byId.set(id, { ...byId.get(id), ...row });
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  };
  addRanking(lexicalRows);
  addRanking(vectorRows);
  const fusedLimit = Math.max(1, Number(limit) || 6);
  return [...byId.values()]
    .map((row) => ({ ...row, rrfScore: scores.get(row.id) ?? 0 }))
    .sort((left, right) => (right.rrfScore - left.rrfScore)
      || String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""))
      || (right.reinforcement_count ?? 0) - (left.reinforcement_count ?? 0))
    .slice(0, fusedLimit);
}

function collectPromptContextRows(db, args) {
  if (typeof db.collectPromptContext === "function") {
    return db.collectPromptContext(args);
  }
  return null;
}

function applyFusedMemories(collected, fused) {
  if (!collected?.semanticCtx) {
    return collected;
  }
  collected.semanticCtx.localMemories = fused;
  collected.semanticCtx.memories = fused;
  const lookup = collected.trace?.lookups?.localMemories;
  if (lookup) {
    lookup.includedRows = fused;
    lookup.rows = fused;
  }
  return collected;
}

async function fusePromptContext({
  collected,
  db,
  prompt,
  repository,
  includeOtherRepositories,
  limit,
  config,
  promptNeed,
  fetchImpl,
}) {
  if (promptNeed?.hasTemporalSignal === true || !semanticSearchEnabled(config)) {
    return collected;
  }
  try {
    const semantic = await semanticSearch({
      db,
      query: prompt,
      repository,
      includeOtherRepositories,
      limit,
      fetchImpl,
      config,
    });
    if (!semantic.enabled || !Array.isArray(semantic.rows) || semantic.rows.length === 0) {
      if (collected.trace) {
        collected.trace.lookups = {
          ...collected.trace.lookups,
          fusion: {
            enabled: semantic.enabled === true,
            reason: semantic.enabled ? "no_vector_hits" : "embeddings_disabled",
            error: semantic.error ?? null,
          },
        };
      }
      return collected;
    }
    const lexical = collected.semanticCtx?.localMemories ?? [];
    const fused = fuseLexicalAndVector(lexical, semantic.rows, { limit });
    applyFusedMemories(collected, fused);
    if (collected.trace) {
      collected.trace.lookups = {
        ...collected.trace.lookups,
        fusion: {
          enabled: true,
          reason: "rrf",
          lexicalCount: lexical.length,
          vectorCount: semantic.rows.length,
          fusedCount: fused.length,
        },
      };
    }
    return collected;
  } catch (error) {
    if (collected.trace) {
      collected.trace.lookups = {
        ...collected.trace.lookups,
        fusion: {
          enabled: false,
          reason: "fusion_failed",
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
    return collected;
  }
}

async function rerankPromptContext({ collected, prompt, config, fetchImpl }) {
  if (!collected?.trace) {
    return collected;
  }
  const rows = collected.semanticCtx?.localMemories ?? [];
  const result = await rerankMemories({ prompt, rows, config, fetchImpl });
  if (result.applied) {
    collected.semanticCtx.localMemories = result.rows;
    collected.semanticCtx.memories = result.rows;
    const lookup = collected.trace.lookups?.localMemories;
    if (lookup) {
      lookup.includedRows = result.rows;
      lookup.rows = result.rows;
    }
  }
  collected.trace.lookups = { ...collected.trace.lookups, rerank: result.trace };
  return collected;
}

async function collectRenderedPromptContext(db, args, extra = {}) {
  const collected = collectPromptContextRows(db, args);
  if (!collected) {
    if (typeof db.explainPromptContext === "function") {
      return db.explainPromptContext(args);
    }
    throw new Error("LoreDb does not implement collectPromptContext");
  }
  const fused = await fusePromptContext({
    collected,
    db,
    prompt: extra.prompt ?? args.prompt,
    repository: args.repository,
    includeOtherRepositories: args.includeOtherRepositories,
    limit: args.limit,
    config: extra.config,
    promptNeed: args.promptNeed,
    fetchImpl: extra.fetchImpl,
  });
  const reranked = await rerankPromptContext({
    collected: fused,
    prompt: extra.prompt ?? args.prompt,
    config: extra.config,
    fetchImpl: extra.fetchImpl,
  });
  return renderPromptContext(reranked);
}

async function resolveQueryExpansion({
  config,
  prompt,
  deterministicQuery,
  fetchImpl,
}) {
  if (config?.localInference?.queryExpansion?.enabled !== true) {
    return {
      query: deterministicQuery,
      deterministicQuery,
      addedTerms: [],
      requested: false,
      used: false,
      error: null,
    };
  }
  if (config.localInference.enabled !== true) {
    return {
      query: deterministicQuery,
      deterministicQuery,
      addedTerms: [],
      requested: true,
      used: false,
      error: "provider disabled",
    };
  }
  try {
    const expanded = await expandRetrievalQueryWithLocalInference({
      config: config.localInference,
      prompt,
      deterministicQuery,
      fetchImpl,
    });
    return {
      ...expanded,
      requested: true,
      error: null,
    };
  } catch (error) {
    return {
      query: deterministicQuery,
      deterministicQuery,
      addedTerms: [],
      requested: true,
      used: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function stripHeading(title, text) {
  const heading = `## ${title}`;
  const normalized = String(text || "").trim();
  return normalized.startsWith(heading)
    ? normalized.slice(heading.length).trim()
    : normalized;
}

async function applyRecallCompression({
  result,
  config,
  prompt,
  fetchImpl,
}) {
  const compressionEnabled = config?.localInference?.contextCompression?.enabled === true;
  if (!compressionEnabled) {
    return {
      result,
      diagnostic: { requested: false, used: false, error: null },
    };
  }
  if (config.localInference.enabled !== true) {
    return {
      result,
      diagnostic: { requested: true, used: false, error: "provider disabled" },
    };
  }
  const sectionDetails = result.sectionDetails
    ?? result.trace?.output?.sectionDetails
    ?? [];
  const sections = (sectionDetails.length > 0
    ? sectionDetails
    : sectionsFromRenderedText(result.text, result.trace?.output?.sectionTitles, sectionDetails)
  ).map((section) => ({
    title: section.title,
    text: stripHeading(section.title, section.text ?? section.body ?? ""),
    required: REQUIRED_RECALL_TITLES.some((pattern) => pattern.test(section.title)),
  }));
  try {
    const compressed = await compressContextWithLocalInference({
      config: config.localInference,
      prompt,
      sections,
      fetchImpl,
    });
    if (!compressed.used) {
      return {
        result,
        diagnostic: {
          requested: true,
          used: false,
          reason: compressed.reason ?? "unchanged",
          error: null,
        },
      };
    }
    return {
      result: {
        ...result,
        text: compressed.text,
        sections: compressed.sections.map((section) => `## ${section.title}\n\n${section.text}`),
        estimatedTokens: compressed.estimatedTokens,
      },
      diagnostic: {
        requested: true,
        used: true,
        embeddingsUsed: compressed.embeddingsUsed === true,
        inputTokens: result.estimatedTokens,
        outputTokens: compressed.estimatedTokens,
        error: null,
      },
    };
  } catch (error) {
    return {
      result,
      diagnostic: {
        requested: true,
        used: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function budgetRecallResult(result, config) {
  const totalBudget = Number(config?.budgets?.total);
  const bounded = enforceSectionBudget({
    sections: sectionsFromRenderedText(
      result.text,
      result.trace?.output?.sectionTitles,
      result.trace?.output?.sectionDetails ?? result.sectionDetails,
    ),
    totalBudget,
    requiredTitles: REQUIRED_RECALL_TITLES,
  });
  const trace = result.trace
    ? filterTraceIncludedRows(result.trace, bounded.text)
    : result.trace;
  if (trace) {
    trace.output = {
      ...trace.output,
      sectionTitles: bounded.sections.map((section) => section.title),
      sectionDetails: bounded.sections.map((section) => ({
        title: section.title,
        source: section.source,
        budget: section.budget ?? null,
        usedTokens: estimateTokens(section.text),
        entryCount: section.entryCount ?? null,
      })),
      estimatedTokens: bounded.estimatedTokens,
    };
  }
  return {
    ...result,
    text: bounded.text,
    sections: bounded.sections.map((section) => section.text),
    sectionDetails: bounded.sections,
    estimatedTokens: bounded.estimatedTokens,
    trace,
  };
}

function composePromptRecall({
  prompt,
  retrievalPrompt,
  repository,
  need,
  base,
  onboarding,
  directives,
  workstreamLookup,
  operationsEnabled,
}) {
  const rawText = [
    onboarding.text,
    directives.text,
    workstreamLookup.text,
    base.text,
  ].filter(Boolean).join("\n\n");
  const baseSections = Array.isArray(base.trace?.output?.sectionTitles)
    ? base.trace.output.sectionTitles
    : [];
  const sectionTitles = [
    ...(onboarding.text ? [onboarding.title] : []),
    ...(directives.text ? ["Standing Directives"] : []),
    ...(workstreamLookup.text ? ["Active Workstream"] : []),
    ...baseSections,
  ];
  const trace = {
    ...base.trace,
    mode: operationsEnabled ? base.trace?.mode : "legacy_prompt_context",
    lookups: {
      onboarding: onboarding.trace,
      directives: directives.trace,
      workstreamOverlays: workstreamLookup.trace ?? {
        enabled: false,
        query: prompt,
        rows: [],
        includedRows: [],
        reason: "memory_operations_disabled",
      },
      ...base.trace?.lookups,
    },
    output: {
      ...base.trace?.output,
      sectionTitles,
    },
  };
  return {
    prompt,
    retrievalPrompt,
    repository,
    promptNeed: need,
    text: rawText,
    trace,
    directives: directives.rows,
    overlays: workstreamLookup.overlays ?? [],
    estimatedTokens: estimateTokens(rawText),
  };
}

function emptyPhaseBundle(prompt, reason) {
  return {
    rows: [],
    text: "",
    title: null,
    overlays: [],
    trace: { enabled: false, reason },
  };
}

async function assemblePromptRecall({
  db,
  prompt,
  retrievalPrompt,
  repository,
  includeOtherRepositories,
  limit,
  sessionStore,
  config,
  promptNeed,
  fetchImpl,
  phases,
}) {
  const need = promptNeed ?? detectPromptContextNeed(prompt);
  const operationsEnabled = readMemoryOperationsEnabled(config);
  const extrasReason = operationsEnabled ? "phase_disabled" : "memory_operations_disabled";
  const activePhases = operationsEnabled
    ? phases
    : { ...phases, onboarding: false, directives: false, workstream: false };
  const callerQuery = normalizeText(retrievalPrompt) || prompt;
  const shouldExpand = retrievalPrompt == null;
  const queryExpansion = shouldExpand
    ? await resolveQueryExpansion({
      config,
      prompt,
      deterministicQuery: callerQuery,
      fetchImpl,
    })
    : {
      query: callerQuery,
      deterministicQuery: callerQuery,
      addedTerms: [],
      requested: false,
      used: false,
      error: null,
    };

  const collectArgs = {
    prompt: queryExpansion.query,
    repository,
    includeOtherRepositories,
    limit,
    sessionStore,
    promptNeed: need,
  };
  const renderExtra = { prompt, config, fetchImpl };
  let base = await collectRenderedPromptContext(db, collectArgs, renderExtra);
  if (queryExpansion.used && !recallHasQueryEvidence({ trace: base.trace })) {
    base = await collectRenderedPromptContext(db, {
      ...collectArgs,
      prompt: queryExpansion.deterministicQuery,
    }, renderExtra);
    queryExpansion.fallbackUsed = true;
  }

  const onboarding = activePhases.onboarding === true
    ? buildOnboardingSection({ db, promptNeed: need })
    : emptyPhaseBundle(prompt, extrasReason);
  const directives = activePhases.directives === true && need.identityOnly !== true
    ? await fetchDirectives({
      db,
      prompt: normalizeText(retrievalPrompt) || normalizeText(prompt),
      repository,
      includeOtherRepositories,
      config,
      fetchImpl,
    })
    : emptyPhaseBundle(prompt, need.identityOnly === true ? "identity_only_skip" : extrasReason);
  const workstreamLookup = activePhases.workstream === true
    ? findRelevantWorkstreamOverlays({
      db,
      prompt: queryExpansion.fallbackUsed ? queryExpansion.deterministicQuery : queryExpansion.query,
      repository,
      includeOtherRepositories,
      promptNeed: need,
      config,
      limit: Math.max(1, Math.min(2, limit)),
    })
    : emptyPhaseBundle(prompt, extrasReason);

  let result = composePromptRecall({
    prompt,
    retrievalPrompt: queryExpansion.fallbackUsed ? queryExpansion.deterministicQuery : queryExpansion.query,
    repository,
    need,
    base,
    onboarding,
    directives,
    workstreamLookup,
    operationsEnabled,
  });
  result = budgetRecallResult(result, config);
  const compressed = await applyRecallCompression({
    result,
    config,
    prompt,
    fetchImpl,
  });
  result = budgetRecallResult(compressed.result, config);
  const localInference = {
    queryExpansion,
    contextCompression: compressed.diagnostic,
  };
  if (result.trace) {
    result.trace.localInference = localInference;
    result.trace.output = {
      ...result.trace.output,
      estimatedTokens: result.estimatedTokens,
    };
  }
  return {
    ...result,
    queryExpansion,
    localInference,
  };
}

// Redaction happens at the single point where recall text becomes the payload
// the agent receives, so every section (directives, memories, episodes,
// overlays) is covered without touching each renderer. Rows, traces and the
// database keep the real content: this is about what reaches a model.
function redactRecallPayload(result) {
  if (!result) {
    return result;
  }
  const text = redactSensitiveContent(result.text ?? "");
  const sections = Array.isArray(result.sections)
    ? result.sections.map((section) => (typeof section === "string" ? redactSensitiveContent(section) : section))
    : result.sections;
  // sectionDetails is a programmatic field today, but it carries the same text:
  // redact it rather than rely on every future consumer not rendering it.
  const sectionDetails = Array.isArray(result.sectionDetails)
    ? result.sectionDetails.map((detail) => (detail && typeof detail.text === "string"
      ? { ...detail, text: redactSensitiveContent(detail.text) }
      : detail))
    : result.sectionDetails;
  if (typeof result.estimatedTokens !== "number") {
    return { ...result, text, sections, sectionDetails };
  }
  // The mask is shorter than what it replaces, so recompute instead of
  // reporting a number larger than the payload.
  const estimatedTokens = estimateTokens(text);
  const trace = result.trace
    ? { ...result.trace, output: { ...result.trace.output, estimatedTokens } }
    : result.trace;
  return { ...result, text, sections, sectionDetails, estimatedTokens, trace };
}

export async function assembleRecall({
  db,
  prompt,
  retrievalPrompt = null,
  repository,
  includeOtherRepositories = false,
  limit = 6,
  sessionSource = null,
  sessionStore = null,
  config = null,
  promptNeed = null,
  fetchImpl = globalThis.fetch,
  phases = PROMPT_RECALL_PHASES,
  proceduralProfile = null,
  includeTrace = false,
  includeProposalAwareness = false,
} = {}) {
  const resolvedConfig = config ?? db?.config ?? {};
  const store = sessionSource ?? sessionStore;
  const resolvedPhases = {
    procedural: false,
    proposals: false,
    onboarding: false,
    directives: true,
    workstream: true,
    ...phases,
  };

  if (resolvedPhases.procedural === true || resolvedPhases.proposals === true) {
    const result = await assembleMemoryCapsule({
      prompt,
      repository,
      proceduralProfile,
      db,
      sessionStore: store,
      config: resolvedConfig,
      includeTrace,
      includeProposalAwareness: resolvedPhases.proposals === true || includeProposalAwareness === true,
      fetchImpl,
    });
    return redactRecallPayload({
      prompt,
      retrievalPrompt: retrievalPrompt ?? prompt,
      repository,
      promptNeed: result.trace?.promptNeed ?? detectPromptContextNeed(prompt),
      text: result.text,
      sections: result.sections,
      sectionDetails: result.sectionDetails,
      estimatedTokens: result.estimatedTokens,
      trace: result.trace,
      localInference: result.localInference,
      queryExpansion: result.localInference?.queryExpansion ?? null,
      directives: [],
      overlays: [],
    });
  }

  const promptRecall = await assemblePromptRecall({
    db,
    prompt,
    retrievalPrompt,
    repository,
    includeOtherRepositories,
    limit,
    sessionStore: store,
    config: resolvedConfig,
    promptNeed,
    fetchImpl,
    phases: resolvedPhases,
  });
  return redactRecallPayload(promptRecall);
}
