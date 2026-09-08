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

export { detectPromptContextNeed, extractQueryTerms } from "./prompt-need.mjs";

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

function isHistoricalExtractorPreference(row) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  if (metadata.source !== "rule_extractor") {
    return false;
  }
  const tags = typeof row.tags === "string"
    ? row.tags.split(/\s+/).filter(Boolean)
    : Array.isArray(row.tags) ? row.tags : [];
  return tags.includes("preference")
    || metadata.confidenceBasis === "explicit_preference_sentence"
    || metadata.confidenceBasis === "standing_policy_sentence";
}

function fetchDirectives({ db, repository, includeOtherRepositories, config }) {
  if (!readDirectivesEnabled(config)) {
    return { rows: [], text: "", trace: { enabled: false, reason: "directives_disabled" } };
  }
  const directiveRows = db.searchSemantic({
    query: "",
    repository,
    includeOtherRepositories,
    types: ["directive"],
    limit: 6,
  });
  const historicalRows = db.searchSemantic({
    query: "",
    repository,
    includeOtherRepositories,
    types: ["user_preference"],
    standingExtractorPolicy: true,
    limit: 6,
  }).filter(isHistoricalExtractorPreference);
  const seen = new Set();
  const rows = [];
  for (const row of [...directiveRows, ...historicalRows]) {
    const key = row.id ?? normalizeText(row.content).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push(row);
    if (rows.length >= 6) {
      break;
    }
  }
  if (rows.length === 0) {
    return { rows: [], text: "", trace: { enabled: true, reason: "no_directives_found" } };
  }
  const lines = ["## Standing Directives", ""];
  for (const row of rows) {
    const content = normalizeText(row.content);
    if (content) {
      lines.push(`- ${content}`);
    }
  }
  return {
    rows,
    text: lines.join("\n"),
    trace: { enabled: true, reason: "directives_included", count: rows.length },
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
  return renderPromptContext(fused);
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
    ? fetchDirectives({ db, repository, includeOtherRepositories, config })
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
    return {
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
    };
  }

  return assemblePromptRecall({
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
}
