import { promptSearchQuery, extractMeaningfulPromptTerms, expandPromptSearchTerms, scorePromptFallbackRows } from "../context/prompt-search-query.mjs";
import { detectPromptContextNeed } from "../context/prompt-need.mjs";
import { formatSemanticContextLine, renderPromptContext } from "../context/prompt-context-render.mjs";
import { detectAssistantIdentityName, MEMORY_SCOPE } from "../memory/memory-scope.mjs";
import { buildStyleAddressingSection, isStyleAddressingMemory } from "../context/style-addressing.mjs";
import { readTemporalQueryNormalizationEnabled } from "../rollout/rollout-flags.mjs";
import { extractFtsTerms as extractNormalizedFtsTerms, extractDirectTerms as extractNormalizedDirectTerms, extractTemporalContentTerms as extractNormalizedTemporalContentTerms, inferDateFromPrompt as inferNormalizedDateFromPrompt, normalizeFtsToken, QUERY_ALIASES, tokenizeText } from "../utils/query-normalizer.mjs";
import { normalizeText } from "../utils/text-normalizer.mjs";
import { isCrossRepoRow, serializeSessionTraceRow, setPromptTemporalVerifierTraceState } from "./db-temporal.mjs";
import { serializeEpisodeTraceRow, buildLocalEligibility } from "./db-trace-serializers.mjs";

export function normalizeTraceMemoryRow(memory) {
  return memory && typeof memory === "object" ? memory : {};
}

export function buildSemanticTraceIdentity(memory) {
  return {
    id: memory.id ?? null,
    type: memory.type ?? null,
    scope: memory.scope ?? null,
    scopeSource: memory.scope_source ?? null,
    repository: memory.repository ?? null,
  };
}

export function buildSemanticTraceMetadata(memory) {
  return {
    updatedAt: memory.updated_at ?? null,
    canonicalKey: memory.canonical_key ?? null,
    reinforcementCount: memory.reinforcement_count ?? 1,
    lastSeenAt: memory.last_seen_at ?? null,
  };
}

export function serializeSemanticRows(rows, repository) {
  return rows.map((memory) => serializeSemanticTraceRow(memory, repository));
}

export function serializeEpisodeRows(rows, repository) {
  return rows.map((episode) => serializeEpisodeTraceRow(episode, repository));
}

export function serializeSessionRows(rows, repository) {
  return rows.map((session) => serializeSessionTraceRow(session, repository));
}

export function serializeSemanticTraceRow(memory, currentRepository = null) {
  const normalizedMemory = normalizeTraceMemoryRow(memory);
  return {
    ...buildSemanticTraceIdentity(normalizedMemory),
    ...buildSemanticTraceMetadata(normalizedMemory),
    crossRepo: isCrossRepoRow(normalizedMemory, currentRepository),
    content: normalizeText(normalizedMemory.content),
  };
}

export function buildStyleAddressingTraceLookup({
  effectiveStyleSection,
  assistantPersonaRows,
  relationshipPreferenceRows,
  repository,
}) {
  const styleRows = [
    ...serializeSemanticRows(assistantPersonaRows, repository),
    ...serializeSemanticRows(relationshipPreferenceRows, repository),
  ];
  return {
    enabled: effectiveStyleSection.trace.enabled,
    ambientEnabled: effectiveStyleSection.trace.ambientEnabled,
    includeAmbient: effectiveStyleSection.trace.includeAmbient,
    promptLocal: effectiveStyleSection.trace.promptLocal,
    rows: styleRows,
    includedRows: effectiveStyleSection.trace.includeAmbient ? styleRows : [],
    reason: effectiveStyleSection.trace.reason,
  };
}

export function buildCrossRepoPreferencesTraceLookup({
  allowGenericCrossRepoFallback,
  crossRepoPreferenceRows,
  crossRepoPreferences,
  repository,
}) {
  return {
    enabled: allowGenericCrossRepoFallback,
    scopes: [MEMORY_SCOPE.TRANSFERABLE],
    rows: serializeSemanticRows(crossRepoPreferenceRows, repository),
    includedRows: serializeSemanticRows(crossRepoPreferences, repository),
    filtered: crossRepoPreferenceRows
      .filter((memory) => !isCrossRepoRow(memory, repository))
      .map((memory) => ({
        stage: "cross_repo_filter",
        reason: "same_repository",
        row: serializeSemanticTraceRow(memory, repository),
      })),
    reason: null,
  };
}

export function buildCrossRepoEpisodesTraceLookup({
  allowGenericCrossRepoFallback,
  crossRepoEpisodeDetails,
  crossRepoEpisodes,
  repository,
}) {
  return {
    enabled: allowGenericCrossRepoFallback,
    scopes: [MEMORY_SCOPE.TRANSFERABLE],
    rankedRows: crossRepoEpisodeDetails?.trace?.rankedRows ?? [],
    includedRows: serializeEpisodeRows(crossRepoEpisodes, repository),
    filtered: [
      ...(crossRepoEpisodeDetails?.trace?.filtered ?? []),
      ...((crossRepoEpisodeDetails?.episodes ?? [])
        .filter((episode) => !isCrossRepoRow(episode, repository))
        .map((episode) => ({
          stage: "cross_repo_filter",
          reason: "same_repository",
          row: serializeEpisodeTraceRow(episode, repository),
        }))),
    ],
    reason: null,
  };
}

export function serializeDaySummaryTraceRow(summary, currentRepository = null) {
  return {
    repository: summary.repository ?? null,
    dateKey: summary.date_key ?? null,
    computedAt: summary.computed_at ?? null,
    crossRepo: isCrossRepoRow(summary, currentRepository),
    summary: normalizeText(summary.summary),
  };
}

export function createPromptContextTrace({
  prompt,
  repository,
  allowCrossRepoFallback,
  allowGenericCrossRepoFallback,
  promptTerms,
  identityName,
  temporalDate,
  memories,
  localMemories,
  identityMemories,
  effectiveStyleSection,
  assistantPersonaRows,
  relationshipPreferenceRows,
  daySummaryRows,
  includedDaySummaryRows,
  episodeDetails,
  crossRepoPreferenceRows,
  crossRepoPreferences,
  crossRepoEpisodeDetails,
  crossRepoEpisodes,
  crossRepoHints,
  sessionStore,
}) {
  return {
    mode: "prompt_context",
    repository,
    includeOtherRepositories: allowCrossRepoFallback,
    promptTerms,
    identityName: identityName ?? null,
    temporalDate,
    temporal: null,
    eligibility: {
      localSemantic: buildLocalEligibility(repository),
      localEpisodes: buildLocalEligibility(repository),
      crossRepoFallback: allowCrossRepoFallback ? [MEMORY_SCOPE.TRANSFERABLE] : [],
    },
    lookups: {
      localMemories: {
        query: prompt,
        types: ["commitment", "open_loop", "rejected_approach", "blocker", "user_preference", "assistant_identity", "user_identity", "assistant_goal", "recurring_mistake", "decision", "learned_rule"],
        rows: serializeSemanticRows(memories, repository),
        includedRows: serializeSemanticRows(localMemories, repository),
      },
      identityMemories: {
        query: identityName ?? "",
        scopes: [MEMORY_SCOPE.GLOBAL],
        rows: serializeSemanticRows(identityMemories, repository),
        includedRows: serializeSemanticRows(identityMemories, repository),
      },
      styleAddressing: buildStyleAddressingTraceLookup({
        effectiveStyleSection,
        assistantPersonaRows,
        relationshipPreferenceRows,
        repository,
      }),
      daySummary: {
        date: temporalDate,
        rows: daySummaryRows.map((summary) => serializeDaySummaryTraceRow(summary, repository)),
        includedRows: includedDaySummaryRows.map((summary) => serializeDaySummaryTraceRow(summary, repository)),
        included: false,
        reason: null,
      },
      localEpisodes: episodeDetails.trace,
      crossRepoPreferences: buildCrossRepoPreferencesTraceLookup({
        allowGenericCrossRepoFallback,
        crossRepoPreferenceRows,
        crossRepoPreferences,
        repository,
      }),
      crossRepoEpisodes: buildCrossRepoEpisodesTraceLookup({
        allowGenericCrossRepoFallback,
        crossRepoEpisodeDetails,
        crossRepoEpisodes,
        repository,
      }),
      crossRepoHints: {
        enabled: allowGenericCrossRepoFallback && !!sessionStore,
        rows: serializeSessionRows(crossRepoHints, repository),
        includedRows: [],
        reason: null,
      },
      temporalVerifier: {
        enabled: !!sessionStore && temporalDate !== null,
        date: temporalDate,
        rows: [],
        includedRows: [],
        reason: null,
      },
    },
    omissions: [],
    output: {
      sectionTitles: [],
      sectionDetails: [],
      estimatedTokens: 0,
    },
  };
}

export function dedupeSemanticContextRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = `${row.type}::${normalizeText(row.content).toLowerCase()}::${row.scope ?? ""}::${row.repository ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export function buildDefaultPromptNeed(prompt, includeOtherRepositories = false) {
  const detected = detectPromptContextNeed(prompt);
  return {
    ...detected,
    allowCrossRepoFallback: detected.allowCrossRepoFallback || includeOtherRepositories,
  };
}

export function extractTemporalContentTerms(query, config = null) {
  if (!readTemporalQueryNormalizationEnabled(config)) {
    return extractNormalizedDirectTerms(query);
  }
  return extractNormalizedTemporalContentTerms(query);
}

export function withCurrentRepository(rows, repository) {
  return rows.map((row) => ({
    ...row,
    currentRepository: repository,
  }));
}

export function inferDateFromPrompt(prompt, config = null) {
  if (!readTemporalQueryNormalizationEnabled(config)) {
    const text = String(prompt || "").toLowerCase();
    const now = new Date();
    const startOfUtcDay = new Date(now);
    startOfUtcDay.setUTCHours(0, 0, 0, 0);

    if (text.includes("today")) {
      return startOfUtcDay.toISOString().slice(0, 10);
    }
    if (text.includes("yesterday")) {
      const value = new Date(startOfUtcDay);
      value.setUTCDate(value.getUTCDate() - 1);
      return value.toISOString().slice(0, 10);
    }

    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const namedDay = weekdays.find((weekday) => text.includes(weekday));
    if (!namedDay) {
      return null;
    }

    const targetIndex = weekdays.indexOf(namedDay);
    const currentIndex = now.getUTCDay();
    const diff = (currentIndex - targetIndex + 7) % 7 || 7;
    const value = new Date(startOfUtcDay);
    value.setUTCDate(value.getUTCDate() - diff);
    return value.toISOString().slice(0, 10);
  }
  return inferNormalizedDateFromPrompt(prompt, { now: config?.now });
}

export function buildExplainPromptTrace({ prompt, repository, allowCrossRepoFallback, promptTerms, identityName, semanticCtx, temporalCtx, crossRepoCtx, sessionStore }) {
  return createPromptContextTrace({
    prompt,
    repository,
    allowCrossRepoFallback,
    allowGenericCrossRepoFallback: crossRepoCtx.allowGenericCrossRepoFallback,
    promptTerms,
    identityName,
    temporalDate: temporalCtx.temporalDate,
    memories: semanticCtx.memories,
    localMemories: semanticCtx.localMemories,
    identityMemories: semanticCtx.identityMemories,
    effectiveStyleSection: temporalCtx.effectiveStyleSection,
    assistantPersonaRows: semanticCtx.assistantPersonaRows,
    relationshipPreferenceRows: semanticCtx.relationshipPreferenceRows,
    daySummaryRows: temporalCtx.daySummaryRows,
    includedDaySummaryRows: temporalCtx.includedDaySummaryRows,
    episodeDetails: temporalCtx.episodeDetails,
    crossRepoPreferenceRows: crossRepoCtx.crossRepoPreferenceRows,
    crossRepoPreferences: crossRepoCtx.crossRepoPreferences,
    crossRepoEpisodeDetails: crossRepoCtx.crossRepoEpisodeDetails,
    crossRepoEpisodes: crossRepoCtx.crossRepoEpisodes,
    crossRepoHints: crossRepoCtx.crossRepoHints,
    sessionStore,
  });
}

export function searchPromptSemanticRows(owner, {
  query,
  repository,
  types,
  scopes,
  limit,
  includeOtherRepositories = false,
  expandAliases = true,
}) {
  return withCurrentRepository(owner.searchSemantic({
    query,
    repository,
    includeOtherRepositories,
    types,
    scopes,
    limit,
    expandAliases,
  }), repository);
}

export function searchPromptSemanticFallback(owner, {
  prompt,
  repository,
  types = [],
  scopes = [],
  limit = 8,
  includeOtherRepositories = false,
  now = new Date(),
}) {
  const terms = extractMeaningfulPromptTerms(prompt, { maxTerms: 8 });
  if (terms.length === 0) return [];
  const queryTerms = expandPromptSearchTerms(terms, { maxTerms: 8, maxVariants: 16 });
  const maxCandidates = Math.max(64, Math.min(256, Math.max(limit, 1) * 32));
  const rowsById = new Map();
  for (let index = 0; index < queryTerms.length; index += 1) {
    const remainingTerms = queryTerms.length - index;
    const remainingRows = maxCandidates - rowsById.size;
    if (remainingRows <= 0) break;
    const termLimit = Math.max(8, Math.ceil(remainingRows / remainingTerms));
    const rows = owner.searchSemantic({
      query: queryTerms[index],
      repository,
      includeOtherRepositories,
      types,
      scopes,
      limit: Math.min(64, termLimit),
      expandAliases: false,
      now,
    });
    for (const row of rows) {
      if (!rowsById.has(row.id)) rowsById.set(row.id, row);
      if (rowsById.size >= maxCandidates) break;
    }
  }
  return scorePromptFallbackRows([...rowsById.values()], terms, { limit });
}

export function buildPromptSemanticContext(owner, { prompt, repository, limit, identityName, identityOnly }) {
  let memories = !identityOnly
    ? owner.searchPromptSemanticRows({
        query: prompt,
        repository,
        includeOtherRepositories: false,
        types: ["commitment", "open_loop", "rejected_approach", "blocker", "user_preference", "assistant_identity", "user_identity", "assistant_goal", "recurring_mistake", "decision", "learned_rule"],
        limit,
      })
    : [];
  const contentQuery = promptSearchQuery(prompt);
  if (!identityOnly && memories.length < limit && contentQuery) {
    const fallbackRows = owner.searchPromptSemanticFallback({
      prompt,
      repository,
      includeOtherRepositories: false,
      types: ["commitment", "open_loop", "rejected_approach", "blocker", "user_preference", "assistant_identity", "user_identity", "assistant_goal", "recurring_mistake", "decision", "learned_rule"],
      limit,
    });
    const byId = new Map(memories.map((row) => [row.id, row]));
    for (const row of fallbackRows) {
      if (!byId.has(row.id)) byId.set(row.id, row);
      if (byId.size >= limit) break;
    }
    memories = [...byId.values()].slice(0, limit);
  }
  const identityMemories = identityName
    ? owner.searchPromptSemanticRows({
        query: "",
        repository,
        includeOtherRepositories: false,
        types: ["assistant_identity"],
        scopes: [MEMORY_SCOPE.GLOBAL],
        limit: 4,
      })
    : [];
  const assistantPersonaRows = owner.searchPromptSemanticRows({
    query: identityName || "assistant preferred human name",
    repository,
    includeOtherRepositories: false,
    types: ["assistant_identity"],
    scopes: [MEMORY_SCOPE.GLOBAL],
    limit: 2,
  });
  const relationshipPreferenceRows = !identityOnly
    ? owner.searchPromptSemanticRows({
        query: "",
        repository,
        includeOtherRepositories: false,
        types: ["interaction_style", "user_identity", "user_preference", "recurring_mistake"],
        scopes: [MEMORY_SCOPE.GLOBAL],
        limit: 6,
      }).filter((memory) => isStyleAddressingMemory(memory)).slice(0, 4)
    : [];

  return {
    memories,
    identityMemories,
    localMemories: dedupeSemanticContextRows([
      ...identityMemories,
      ...memories,
    ]),
    assistantPersonaRows,
    relationshipPreferenceRows,
  };
}

export function buildEffectivePromptStyleSection(owner, {
  prompt,
  need,
  assistantPersonaRows,
  relationshipPreferenceRows,
  pureTemporalRecall,
}) {
  const styleSection = buildStyleAddressingSection({
    prompt,
    promptNeed: need,
    config: owner.config,
    assistantPersonaRows,
    relationshipPreferenceRows,
    renderSemantic: formatSemanticContextLine,
  });
  return pureTemporalRecall && need.wantsStyleContext !== true
    ? {
        ...styleSection,
        text: "",
        trace: {
          ...styleSection.trace,
          enabled: false,
          includeAmbient: false,
          reason: "suppressed_for_pure_temporal_recall",
        },
      }
    : styleSection;
}

export function filterPromptDaySummaries(owner, daySummaryRows, pureTemporalRecall, temporalContentTerms) {
  return daySummaryRows.filter((summary) => {
    if (pureTemporalRecall || temporalContentTerms.length === 0) {
      return true;
    }
    const summaryTokens = tokenizeText(summary.summary);
    return temporalContentTerms.some((term) => summaryTokens.has(term));
  });
}

export function buildIdentityOnlyEpisodeDetails(owner, prompt, repository) {
  return {
    episodes: [],
    trace: {
      prompt,
      repository,
      includeOtherRepositories: false,
      eligibleScopes: buildLocalEligibility(repository),
      primaryTerms: [],
      terms: [],
      lexicalQuery: "",
      rankedRows: [],
      includedRows: [],
      filtered: [],
      reason: "identity_only_prompt",
    },
  };
}

export function buildPromptEpisodeContext(owner, {
  prompt,
  repository,
  limit,
  allowRepoLocalTaskContext,
  allowCrossRepoFallback,
  pureTemporalRecall,
  temporalDate,
  includedDaySummaryRows,
}) {
  if (!allowRepoLocalTaskContext) {
    return owner.buildIdentityOnlyEpisodeDetails(prompt, repository);
  }
  if (pureTemporalRecall && includedDaySummaryRows.length > 0) {
    return {
      episodes: [],
      trace: {
        prompt,
        repository,
        includeOtherRepositories: allowCrossRepoFallback,
        eligibleScopes: allowCrossRepoFallback ? [] : buildLocalEligibility(repository),
        primaryTerms: [],
        terms: [],
        lexicalQuery: "",
        rankedRows: [],
        includedRows: [],
        filtered: [],
        reason: "suppressed_by_day_summaries",
      },
    };
  }
  return pureTemporalRecall
    ? owner.findRelevantEpisodesByDateDetailed({
        date: temporalDate,
        repository,
        includeOtherRepositories: allowCrossRepoFallback,
        limit: Math.max(2, Math.floor(limit / 2)),
      })
    : owner.findRelevantEpisodesDetailed({
        prompt,
        repository,
        includeOtherRepositories: false,
        limit: Math.max(2, Math.floor(limit / 2)),
      });
}

export function buildPromptTemporalContext(owner, {
  prompt,
  repository,
  need,
  limit,
  allowRepoLocalTaskContext,
  allowCrossRepoFallback,
  assistantPersonaRows,
  relationshipPreferenceRows,
}) {
  const temporalDate = need.hasTemporalSignal ? inferDateFromPrompt(prompt, owner.config) : null;
  const temporalContentTerms = temporalDate ? extractTemporalContentTerms(prompt, owner.config) : [];
  const pureTemporalRecall = temporalDate !== null && temporalContentTerms.length === 0;
  const daySummaryRows = temporalDate
    ? owner.getDaySummaries({
        date: temporalDate,
        repository,
        includeOtherRepositories: allowCrossRepoFallback && pureTemporalRecall,
        limit: pureTemporalRecall && allowCrossRepoFallback
          ? Math.max(2, Math.min(limit, 4))
          : 1,
      })
    : [];
  const includedDaySummaryRows = owner.filterPromptDaySummaries(
    daySummaryRows,
    pureTemporalRecall,
    temporalContentTerms,
  );
  const episodeDetails = owner.buildPromptEpisodeContext({
    prompt,
    repository,
    limit,
    allowRepoLocalTaskContext,
    allowCrossRepoFallback,
    pureTemporalRecall,
    temporalDate,
    includedDaySummaryRows,
  });
  return {
    temporalDate,
    temporalContentTerms,
    pureTemporalRecall,
    daySummaryRows,
    includedDaySummaryRows,
    episodeDetails,
    episodes: withCurrentRepository(episodeDetails.episodes, repository),
    effectiveStyleSection: owner.buildEffectivePromptStyleSection({
      prompt,
      need,
      assistantPersonaRows,
      relationshipPreferenceRows,
      pureTemporalRecall,
    }),
  };
}

export function buildPromptCrossRepoContext(owner, {
  lexicalPrompt,
  repository,
  allowCrossRepoFallback,
  pureTemporalRecall,
  sessionStore,
  limit,
}) {
  const allowGenericCrossRepoFallback = allowCrossRepoFallback && !pureTemporalRecall;
  const crossRepoPreferenceLimit = Math.max(1, Math.min(2, Math.floor(limit / 2) || 1));
  const selectCrossRepoRows = (rows) => withCurrentRepository(
    rows
      .filter((row) => isCrossRepoRow(row, repository))
      .slice(0, crossRepoPreferenceLimit),
    repository,
  );
  const crossRepoPreferenceRows = allowGenericCrossRepoFallback
    ? owner.searchSemantic({
        query: lexicalPrompt,
        repository,
        includeOtherRepositories: true,
        types: ["user_preference", "rejected_approach", "recurring_mistake"],
        scopes: [MEMORY_SCOPE.TRANSFERABLE],
        limit: Math.max(limit * 4, 8),
      })
    : [];
  const crossRepoPreferences = allowGenericCrossRepoFallback
    ? selectCrossRepoRows(crossRepoPreferenceRows)
    : [];
  const crossRepoEpisodeDetails = allowGenericCrossRepoFallback
    ? owner.findRelevantEpisodesDetailed({
        prompt: lexicalPrompt,
        repository,
        includeOtherRepositories: true,
        scopes: [MEMORY_SCOPE.TRANSFERABLE],
        limit: Math.max(limit * 4, 8),
      })
    : null;
  const crossRepoEpisodes = allowGenericCrossRepoFallback
    ? selectCrossRepoRows(crossRepoEpisodeDetails.episodes)
    : [];
  const crossRepoHints = allowGenericCrossRepoFallback && sessionStore
    ? withCurrentRepository(
        sessionStore.findRelevantSessions({
          prompt: lexicalPrompt,
          repository: null,
          limit: Math.max(limit * 4, 8),
        }).filter((session) => isCrossRepoRow(session, repository))
          .slice(0, crossRepoPreferenceLimit),
        repository,
      )
    : [];
  return {
    allowGenericCrossRepoFallback,
    crossRepoPreferenceRows,
    crossRepoPreferences,
    crossRepoEpisodeDetails,
    crossRepoEpisodes,
    crossRepoHints,
  };
}

export function determinePromptDaySummaryReason(owner, {
  need,
  temporalDate,
  includedDaySummaryRows,
  daySummaryRows,
}) {
  if (!need.hasTemporalSignal) {
    return "no_temporal_signal";
  }
  if (temporalDate === null) {
    return "unresolved_temporal_date";
  }
  if (includedDaySummaryRows.length === 0 && daySummaryRows.length === 0) {
    return "missing_day_summary";
  }
  return includedDaySummaryRows.length === 0
    ? "summary_did_not_match_prompt_terms"
    : null;
}

export function buildPromptTemporalVerifier(owner, {
  repository,
  sessionStore,
  temporalDate,
  pureTemporalRecall,
  allowCrossRepoFallback,
  limit,
  daySummaryReason,
  includedDaySummaryRows,
  episodes,
}) {
  const temporalVerifierEnabled = !!sessionStore && temporalDate !== null && pureTemporalRecall;
  const shouldRunTemporalVerifier = temporalVerifierEnabled
    && includedDaySummaryRows.length === 0
    && episodes.length === 0
    && (daySummaryReason === "missing_day_summary" || daySummaryReason === "summary_did_not_match_prompt_terms");
  const temporalVerifierRows = shouldRunTemporalVerifier
    ? withCurrentRepository(
        sessionStore.findSessionsByDate({
          dateKey: temporalDate,
          repository,
          includeOtherRepositories: allowCrossRepoFallback,
          limit: Math.max(2, Math.min(limit, 3)),
        }).map((session) => ({
          ...session,
          source_type: "session_store_verifier",
          excerpt: session.workspaceSummary || session.summary,
        })),
        repository,
      )
    : [];
  return {
    temporalVerifierEnabled,
    shouldRunTemporalVerifier,
    temporalVerifierRows,
  };
}

export function buildPromptContextFlags(owner, need) {
  return {
    allowRepoLocalTaskContext: need.wantsRepoLocalTaskContext === true
      && need.wantsCrossRepoExamples !== true,
    allowCrossRepoFallback: need.allowCrossRepoFallback === true,
    identityOnly: need.identityOnly === true,
  };
}

export function buildLexicalPrompt(owner, prompt, promptTerms) {
  return promptTerms.length > 0 ? promptTerms.join(" ") : prompt;
}

export function resolvePromptRenderTerms(owner, promptTerms, temporalContentTerms) {
  return temporalContentTerms.length > 0 ? temporalContentTerms : promptTerms;
}

export function buildExplainComputedState(owner, trace, {
  need, temporalCtx, allowCrossRepoFallback, limit, repository, sessionStore, promptTerms,
}) {
  const { temporalDate, temporalContentTerms, pureTemporalRecall, includedDaySummaryRows, daySummaryRows, episodes } = temporalCtx;
  const renderTerms = owner.resolvePromptRenderTerms(promptTerms, temporalContentTerms);
  const hasIncludedDaySummary = includedDaySummaryRows.length > 0;
  const hasIncludedEpisodes = episodes.length > 0;
  const daySummaryReason = owner.determinePromptDaySummaryReason({
    need, temporalDate, includedDaySummaryRows, daySummaryRows,
  });
  const {
    temporalVerifierEnabled,
    shouldRunTemporalVerifier,
    temporalVerifierRows,
  } = owner.buildPromptTemporalVerifier({
    repository, sessionStore, temporalDate, pureTemporalRecall,
    allowCrossRepoFallback, limit, daySummaryReason, includedDaySummaryRows, episodes,
  });
  setPromptTemporalVerifierTraceState({
    trace, repository, sessionStore, temporalDate, pureTemporalRecall,
    temporalVerifierEnabled, shouldRunTemporalVerifier, temporalVerifierRows,
  });
  return { renderTerms, hasIncludedDaySummary, hasIncludedEpisodes, daySummaryReason, shouldRunTemporalVerifier, temporalVerifierRows };
}

export function collectPromptContext(owner, {
  prompt,
  repository,
  includeOtherRepositories = false,
  limit = 6,
  sessionStore = null,
  promptNeed = null,
}) {
  owner.ensureOpen();
  const promptTerms = extractNormalizedFtsTerms(prompt, {
    aliases: QUERY_ALIASES,
    normalize: normalizeFtsToken,
  });
  const lexicalPrompt = owner.buildLexicalPrompt(prompt, promptTerms);
  const identityName = detectAssistantIdentityName(prompt);
  const need = promptNeed ?? buildDefaultPromptNeed(prompt, includeOtherRepositories);
  const flags = owner.buildPromptContextFlags(need);
  const { allowRepoLocalTaskContext, allowCrossRepoFallback, identityOnly } = flags;
  const semanticCtx = owner.buildPromptSemanticContext({ prompt, repository, limit, identityName, identityOnly });
  const temporalCtx = owner.buildPromptTemporalContext({
    prompt, repository, need, limit, allowRepoLocalTaskContext, allowCrossRepoFallback,
    assistantPersonaRows: semanticCtx.assistantPersonaRows,
    relationshipPreferenceRows: semanticCtx.relationshipPreferenceRows,
  });
  // Query-matched style evidence remains useful even when ambient persona
  // injection is disabled. Only suppress duplicate style entries that the
  // dedicated section actually renders, or preserve temporal suppression.
  semanticCtx.localMemories = semanticCtx.localMemories.filter((memory) => !isStyleAddressingMemory(memory)
    || (!need.hasTemporalSignal && !temporalCtx.effectiveStyleSection.text.includes(memory.content)));
  const crossRepoCtx = owner.buildPromptCrossRepoContext({
    lexicalPrompt, repository, allowCrossRepoFallback,
    pureTemporalRecall: temporalCtx.pureTemporalRecall, sessionStore, limit,
  });
  const trace = buildExplainPromptTrace({
    prompt, repository, allowCrossRepoFallback, promptTerms, identityName,
    semanticCtx, temporalCtx, crossRepoCtx, sessionStore,
  });
  const state = owner.buildExplainComputedState(trace, {
    need, temporalCtx, allowCrossRepoFallback, limit, repository, sessionStore, promptTerms,
  });
  return {
    prompt,
    repository,
    sessionStore,
    need,
    flags,
    promptTerms,
    semanticCtx,
    temporalCtx,
    crossRepoCtx,
    state,
    trace,
  };
}

// Deprecated wrapper: prefer assembleRecall. Kept for one PR so existing
// row/trace callers can keep a { text, trace } shape.
export function explainPromptContext(owner, args) {
  return renderPromptContext(owner.collectPromptContext(args));
}

export function buildPromptContext(owner, {
  prompt,
  repository,
  includeOtherRepositories = false,
  limit = 6,
  sessionStore = null,
  promptNeed = null,
}) {
  return owner.explainPromptContext({
    prompt,
    repository,
    includeOtherRepositories,
    limit,
    sessionStore,
    promptNeed,
  }).text;
}
