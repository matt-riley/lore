import { detectPromptContextNeed } from "./capsule-assembler.mjs";
import {
  readDirectivesEnabled,
  readMemoryOperationsEnabled,
  readRetentionSanitizationEnabled,
  readWorkstreamOverlaysEnabled,
} from "./rollout-flags.mjs";
import { sanitizeRetainedList, sanitizeRetainedMetadata, sanitizeRetainedText } from "./retention-sanitizer.mjs";
import {
  buildWorkstreamOverlayMemory,
  findRelevantWorkstreamOverlays,
  formatWorkstreamOverlaySection,
} from "./workstream-overlays.mjs";
import { buildOnboardingSection } from "./onboarding.mjs";
import { collectFilteredReasonSummaries } from "./filtered-reason-summary.mjs";
import { normalizeText } from "./prompt-text-normalizer.mjs";
import { estimateTokens } from "./token-estimator.mjs";

function fetchDirectives({ db, repository, includeOtherRepositories, config }) {
  if (!readDirectivesEnabled(config)) {
    return { rows: [], text: "", trace: { enabled: false, reason: "directives_disabled" } };
  }
  const rows = db.searchSemantic({
    query: "",
    repository,
    includeOtherRepositories,
    types: ["directive"],
    limit: 6,
  });
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

function sanitizeSemanticMemory(memory) {
  return {
    ...memory,
    type: sanitizeRetainedText(memory.type),
    content: sanitizeRetainedText(memory.content),
    tags: sanitizeRetainedList(memory.tags),
    metadata: sanitizeRetainedMetadata(memory.metadata),
  };
}

function buildLegacyRecall({
  db,
  prompt,
  repository,
  includeOtherRepositories,
  limit,
  sessionStore,
  promptNeed,
}) {
  const base = db.explainPromptContext({
    prompt,
    repository,
    includeOtherRepositories,
    limit,
    sessionStore,
    promptNeed,
  });
  return {
    prompt,
    repository,
    promptNeed,
    text: base.text,
    trace: {
      ...base.trace,
      mode: "legacy_prompt_context",
      lookups: {
        workstreamOverlays: {
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
        estimatedTokens: estimateTokens(base.text),
      },
    },
    overlays: [],
    estimatedTokens: estimateTokens(base.text),
  };
}

function summarizeTraceRow(row) {
  if (!row || typeof row !== "object") {
    return "";
  }
  return normalizeText(
    row.content
    || row.summary
    || row.excerpt
    || [
      row.type ?? row.sourceType ?? "row",
      row.repository ? `(${row.repository})` : "",
    ].filter(Boolean).join(" "),
  );
}

function aggregateFilteredReasons(filtered) {
  return collectFilteredReasonSummaries(filtered);
}

const REFLECT_FOCUS = Object.freeze({
  SUMMARY: "summary",
  PATTERNS: "patterns",
  BLOCKERS: "blockers",
  DECISIONS: "decisions",
  NEXT_ACTIONS: "next_actions",
});

const REFLECT_STOP_WORDS = new Set([
  "about", "after", "again", "also", "been", "being", "build", "built",
  "can", "could", "current", "debug", "debugging", "deliverable", "from",
  "have", "into", "just", "like", "look", "made", "make", "more",
  "need", "only", "other", "over", "prompt", "recent", "reflect",
  "reflection", "same", "session", "sessions", "should", "show", "than",
  "that", "them", "then", "there", "these", "they", "this", "those",
  "through", "tool", "using", "want", "what", "when", "where", "which",
  "while", "with", "work", "worked", "working", "would", "your",
]);

const BLOCKER_SIGNAL_PATTERN = /\b(blocker|blocked|constraint|risk|stuck|waiting|dependency|dependencies|miss(?:ing)?|failure|fail(?:ed|ing)?)\b/i;
const DECISION_SIGNAL_PATTERN = /\b(decision|decided|prefer|preferred|avoid|never|always|rejected|rejection|must|should not|do not)\b/i;
const NEXT_ACTION_SIGNAL_PATTERN = /\b(next action|next step|next steps|what(?:'s| is) next|todo|follow[-\s]?up|ship|implement|run|validate|check|update|fix)\b/i;
const PATTERN_SIGNAL_PATTERN = /\b(pattern|patterns|theme|themes|trend|trends|recurring|repeat(?:ed|ing)?|lesson|insight|insights|debug(?:ging)?|regression|routing|trace|retrieval|reflect priorit(?:y|ies))\b/i;
const REFLECT_DECISION_KINDS = new Set(["decision", "reflect_priority", "rejected_approach", "user_preference", "recurring_mistake"]);
const REFLECT_NEXT_ACTION_KINDS = new Set(["next_action", "objective", "mission", "open_loop", "assistant_goal", "commitment"]);
const REFLECT_PATTERN_KINDS = new Set(["reflect_priority", "decision", "blocker"]);
const EXPLICIT_REFLECT_FOCUS = new Set(Object.values(REFLECT_FOCUS));
const REFLECT_SIGNAL_FOCUS_RULES = Object.freeze([
  [BLOCKER_SIGNAL_PATTERN, REFLECT_FOCUS.BLOCKERS],
  [NEXT_ACTION_SIGNAL_PATTERN, REFLECT_FOCUS.NEXT_ACTIONS],
  [DECISION_SIGNAL_PATTERN, REFLECT_FOCUS.DECISIONS],
  [PATTERN_SIGNAL_PATTERN, REFLECT_FOCUS.PATTERNS],
]);
const WORKSTREAM_SCALAR_ENTRY_SPECS = Object.freeze([
  ["mission", "mission"],
  ["objective", "objective"],
]);
const WORKSTREAM_LIST_ENTRY_SPECS = Object.freeze([
  ["constraints", "constraint"],
  ["blockers", "blocker"],
  ["nextActions", "next_action"],
  ["decisions", "decision"],
  ["reflectPriorities", "reflect_priority"],
]);
const REFLECT_FOCUS_BONUS_KIND = Object.freeze({
  [REFLECT_FOCUS.PATTERNS]: "reflect_priority",
  [REFLECT_FOCUS.BLOCKERS]: "blocker",
  [REFLECT_FOCUS.DECISIONS]: "decision",
  [REFLECT_FOCUS.NEXT_ACTIONS]: "next_action",
});
const REFLECT_INSIGHT_BUILDERS = Object.freeze({
  [REFLECT_FOCUS.BLOCKERS]: (entry) => `${entry.kind === "constraint" ? "Constraint" : "Blocker"}: ${truncateText(entry.text)}`,
  [REFLECT_FOCUS.DECISIONS]: (entry) => `${entry.kind === "reflect_priority" ? "Priority" : "Decision"}: ${truncateText(entry.text)}`,
  [REFLECT_FOCUS.NEXT_ACTIONS]: (entry) => `${entry.kind === "objective" || entry.kind === "mission" ? "Direction" : "Next action"}: ${truncateText(entry.text)}`,
  [REFLECT_FOCUS.PATTERNS]: (entry) => `${entry.kind === "reflect_priority" ? "Pattern" : "Signal"}: ${truncateText(entry.text)}`,
});

function truncateText(text, maxLength = 160) {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function humanizeLookupName(name) {
  return String(name || "lookup")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

function dedupeStrings(values, limit = Infinity) {
  const seen = new Set();
  const deduped = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped;
}

function buildLookupEvidenceEntries(rows, {
  lookupName,
  bucket,
  sourceLabel,
}) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    lookupName,
    bucket,
    index,
    text: summarizeTraceRow(row),
    row,
    source: sourceLabel ?? humanizeLookupName(lookupName),
    kind: normalizeText(row?.type ?? row?.sourceType ?? bucket).toLowerCase(),
    repository: row?.repository ?? null,
    crossRepo: row?.crossRepo === true,
  })).filter((entry) => entry.text.length > 0);
}

function dedupeEvidenceEntries(entries, limit = Infinity) {
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    const key = `${entry.lookupName}::${entry.kind}::${entry.text.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped;
}

function readLookupRows(lookup) {
  return {
    matchedRows: Array.isArray(lookup?.rows) ? lookup.rows : [],
    rankedRows: Array.isArray(lookup?.rankedRows) ? lookup.rankedRows : [],
    includedRows: Array.isArray(lookup?.includedRows) ? lookup.includedRows : [],
  };
}

function buildLookupEnvelope(name, lookup) {
  const { matchedRows, rankedRows, includedRows } = readLookupRows(lookup);
  const sourceLabel = humanizeLookupName(name);
  return {
    name,
    label: sourceLabel,
    enabled: lookup?.enabled !== false,
    reason: lookup?.reason ?? null,
    matchedCount: matchedRows.length || rankedRows.length,
    includedCount: includedRows.length,
    filteredReasons: aggregateFilteredReasons(lookup?.filtered),
    includedEntries: buildLookupEvidenceEntries(includedRows, {
      lookupName: name,
      bucket: "included",
      sourceLabel,
    }),
    matchedEntries: buildLookupEvidenceEntries(matchedRows, {
      lookupName: name,
      bucket: "matched",
      sourceLabel,
    }),
    rankedEntries: buildLookupEvidenceEntries(rankedRows, {
      lookupName: name,
      bucket: "ranked",
      sourceLabel,
    }),
  };
}

// fallow-ignore-next-line complexity
function buildSourceAccountingEntry(detail) {
  return {
    title: detail?.title ?? "section",
    source: detail?.source ?? null,
    budget: detail?.budget ?? null,
    usedTokens: detail?.usedTokens ?? 0,
    entryCount: detail?.entryCount ?? 0,
  };
}

function buildSourceAccounting(sectionDetails) {
  return Array.isArray(sectionDetails)
    ? sectionDetails.map(buildSourceAccountingEntry)
    : [];
}

function selectLookupEvidenceEntries(lookup) {
  if (lookup.includedEntries.length > 0) {
    return lookup.includedEntries;
  }
  if (lookup.matchedEntries.length > 0) {
    return lookup.matchedEntries.slice(0, 2);
  }
  return lookup.rankedEntries.slice(0, 2);
}

function buildLookupEnvelopeFromEntry([name, lookup]) {
  return buildLookupEnvelope(name, lookup);
}

function buildEvidenceEnvelope(result) {
  const lookups = Object.entries(result?.trace?.lookups ?? {})
    .map(buildLookupEnvelopeFromEntry);

  const supportingFacts = dedupeStrings(
    lookups.flatMap((lookup) => lookup.includedEntries.map((entry) => entry.text)),
    8,
  );
  const sourceAccounting = buildSourceAccounting(result?.trace?.output?.sectionDetails);
  const evidenceEntries = dedupeEvidenceEntries(
    lookups.flatMap((lookup) => selectLookupEvidenceEntries(lookup)),
    12,
  );

  return {
    sections: result?.trace?.output?.sectionTitles ?? [],
    estimatedTokens: result?.estimatedTokens ?? 0,
    supportingFacts,
    sourceAccounting,
    workstreamOverlays: Array.isArray(result?.overlays) ? result.overlays : [],
    evidenceEntries,
    lookups,
  };
}

export function buildRecallEnvelope(result) {
  const envelope = buildEvidenceEnvelope(result);
  return {
    sections: envelope.sections,
    estimatedTokens: envelope.estimatedTokens,
    supportingFacts: envelope.supportingFacts,
    lookups: envelope.lookups.map((lookup) => ({
      name: lookup.name,
      enabled: lookup.enabled,
      reason: lookup.reason,
      matchedCount: lookup.matchedCount,
      includedCount: lookup.includedCount,
      filteredReasons: lookup.filteredReasons,
      matchedRows: lookup.matchedEntries.map((entry) => entry.text),
      includedRows: lookup.includedEntries.map((entry) => entry.text),
      rankedRows: lookup.rankedEntries.map((entry) => entry.text),
    })),
  };
}

function detectReflectFocus(prompt, requestedFocus = null) {
  if (EXPLICIT_REFLECT_FOCUS.has(requestedFocus)) {
    return requestedFocus;
  }

  const text = normalizeText(prompt).toLowerCase();
  for (const [pattern, focus] of REFLECT_SIGNAL_FOCUS_RULES) {
    if (pattern.test(text)) {
      return focus;
    }
  }
  return /\bwhat do you see\b/.test(text) ? REFLECT_FOCUS.PATTERNS : REFLECT_FOCUS.SUMMARY;
}

function buildWorkstreamEvidenceEntry({ row, source, repository, kind, text, index }) {
  return {
    lookupName: "workstreamOverlays",
    bucket: "included",
    index,
    text,
    row,
    source,
    kind,
    repository,
    crossRepo: false,
  };
}

function appendWorkstreamScalarEntry(entries, overlay, row, source, repository, field, kind) {
  const text = overlay[field];
  if (!text) {
    return;
  }
  entries.push(buildWorkstreamEvidenceEntry({
    row,
    source,
    repository,
    kind,
    text,
    index: entries.length,
  }));
}

function appendWorkstreamListEntries(entries, items, row, source, repository, kind) {
  for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
    entries.push(buildWorkstreamEvidenceEntry({
      row,
      source,
      repository,
      kind,
      text: item,
      index,
    }));
  }
}

function buildWorkstreamEvidenceEntries(overlays) {
  const entries = [];
  for (const overlay of Array.isArray(overlays) ? overlays : []) {
    const source = overlay.title ? `workstream ${JSON.stringify(overlay.title)}` : "active workstream";
    const repository = overlay.repository ?? null;
    const row = {
      type: "workstream_overlay",
      repository,
      crossRepo: false,
    };
    for (const [field, kind] of WORKSTREAM_SCALAR_ENTRY_SPECS) {
      appendWorkstreamScalarEntry(entries, overlay, row, source, repository, field, kind);
    }
    for (const [field, kind] of WORKSTREAM_LIST_ENTRY_SPECS) {
      appendWorkstreamListEntries(entries, overlay[field], row, source, repository, kind);
    }
  }
  return entries;
}

function matchesReflectTextPattern(text, focus) {
  if (focus === REFLECT_FOCUS.BLOCKERS) {
    return BLOCKER_SIGNAL_PATTERN.test(text);
  }
  if (focus === REFLECT_FOCUS.DECISIONS) {
    return DECISION_SIGNAL_PATTERN.test(text);
  }
  if (focus === REFLECT_FOCUS.NEXT_ACTIONS) {
    return NEXT_ACTION_SIGNAL_PATTERN.test(text);
  }
  return PATTERN_SIGNAL_PATTERN.test(text);
}

function matchesReflectKind(kind, focus) {
  if (focus === REFLECT_FOCUS.BLOCKERS) {
    return kind === "blocker" || kind === "constraint";
  }
  if (focus === REFLECT_FOCUS.DECISIONS) {
    return REFLECT_DECISION_KINDS.has(kind);
  }
  if (focus === REFLECT_FOCUS.NEXT_ACTIONS) {
    return REFLECT_NEXT_ACTION_KINDS.has(kind);
  }
  return REFLECT_PATTERN_KINDS.has(kind);
}

export function matchesReflectFocus(entry, focus) {
  if (focus === REFLECT_FOCUS.SUMMARY) {
    return true;
  }
  const text = entry.text.toLowerCase();
  return matchesReflectKind(entry.kind, focus) || matchesReflectTextPattern(text, focus);
}

function scoreReflectEntry(entry, focus) {
  const bucketBonus = {
    included: 4,
    matched: 2,
  };
  const baseScore =
    (entry.lookupName === "workstreamOverlays" ? 5 : 0) +
    (bucketBonus[entry.bucket] ?? 1) +
    (matchesReflectFocus(entry, focus) ? 6 : 0) +
    (REFLECT_FOCUS_BONUS_KIND[focus] === entry.kind ? 4 : 0) +
    (entry.crossRepo ? -1 : 0);
  return baseScore - (entry.index ?? 0) * 0.1;
}

function selectReflectEntries(envelope, focus) {
  const overlayEntries = buildWorkstreamEvidenceEntries(envelope.workstreamOverlays);
  const candidates = dedupeEvidenceEntries([
    ...overlayEntries,
    ...envelope.evidenceEntries,
  ], 20);
  const focused = candidates.filter((entry) => matchesReflectFocus(entry, focus));
  const pool = focused.length > 0 ? focused : candidates;
  return [...pool]
    .map((entry) => ({
      ...entry,
      score: scoreReflectEntry(entry, focus),
    }))
    .sort((left, right) => right.score - left.score || left.text.localeCompare(right.text))
    .slice(0, 4);
}

function tokenizeReflectText(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((part) => part.replace(/^-+|-+$/g, ""))
    .filter((part) => part.length >= 4)
    .filter((part) => !REFLECT_STOP_WORDS.has(part));
}

function buildPatternHighlights(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const tokens = new Set(tokenizeReflectText(entry.text));
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([token]) => token)
    .slice(0, 3);
}

function joinNaturalList(items) {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0];
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

const POPULATED_REFLECT_SUMMARIES = {
  [REFLECT_FOCUS.BLOCKERS]: (highlights) => `Current blockers center on ${joinNaturalList(highlights)}.`,
  [REFLECT_FOCUS.DECISIONS]: (highlights) => `The strongest retained decisions are ${joinNaturalList(highlights)}.`,
  [REFLECT_FOCUS.NEXT_ACTIONS]: (highlights) => `The next concrete actions are ${joinNaturalList(highlights)}.`,
  default: (highlights) => `Retrieved context emphasizes ${joinNaturalList(highlights)}.`,
};

const EMPTY_REFLECT_SUMMARIES = {
  [REFLECT_FOCUS.BLOCKERS]: {
    withOverlays: "No explicit blockers were retained in the active workstream overlays.",
    withoutOverlays: "No explicit blockers were found in the retrieved evidence.",
  },
  [REFLECT_FOCUS.DECISIONS]: {
    withOverlays: "No durable decisions stood out in the retrieved evidence.",
    withoutOverlays: "No durable decisions stood out in the retrieved evidence.",
  },
  [REFLECT_FOCUS.NEXT_ACTIONS]: {
    withOverlays: "The active workstream does not currently retain explicit next actions.",
    withoutOverlays: "No explicit next actions were found in the retrieved evidence.",
  },
};

function buildPatternReflectSummary(entries) {
  const highlights = buildPatternHighlights(entries);
  if (highlights.length > 0) {
    return `Retrieved evidence clusters around ${joinNaturalList(highlights)}.`;
  }
  const fallbackHighlights = dedupeStrings(entries.map((entry) => truncateText(entry.text, 72)), 3);
  return fallbackHighlights.length > 0
    ? `Retrieved evidence repeatedly points to ${joinNaturalList(fallbackHighlights)}.`
    : null;
}

function buildFocusReflectSummary(focus, highlights, hasWorkstreamOverlays) {
  if (highlights.length > 0) {
    const renderSummary = POPULATED_REFLECT_SUMMARIES[focus] ?? POPULATED_REFLECT_SUMMARIES.default;
    return renderSummary(highlights);
  }
  const emptySummary = EMPTY_REFLECT_SUMMARIES[focus];
  if (!emptySummary) {
    return "No reflection-worthy evidence was retrieved for this prompt.";
  }
  return hasWorkstreamOverlays ? emptySummary.withOverlays : emptySummary.withoutOverlays;
}

function buildReflectSummary({ focus, entries, envelope }) {
  if (focus === REFLECT_FOCUS.PATTERNS) {
    const patternSummary = buildPatternReflectSummary(entries);
    if (patternSummary) {
      return patternSummary;
    }
  }
  const highlights = dedupeStrings(entries.map((entry) => truncateText(entry.text, 72)), 3);
  return buildFocusReflectSummary(focus, highlights, envelope.workstreamOverlays.length > 0);
}

function buildReflectInsight(entry, focus) {
  return (REFLECT_INSIGHT_BUILDERS[focus] ?? ((currentEntry) => truncateText(currentEntry.text)))(entry);
}

export function retainMemory({ db, kind = "semantic", memory = null, overlay = null }) {
  if (kind === "workstream") {
    if (!readWorkstreamOverlaysEnabled(db.config)) {
      return {
        id: null,
        kind,
        skipped: true,
        reason: "workstream_overlays_disabled",
        text: "",
      };
    }
    const workstreamMemory = buildWorkstreamOverlayMemory(overlay ?? {});
    const id = db.insertSemanticMemory(workstreamMemory);
    return {
      id,
      kind,
      memory: workstreamMemory,
      text: formatWorkstreamOverlaySection([
        {
          ...overlay,
          title: workstreamMemory.metadata.title,
          mission: workstreamMemory.metadata.mission,
          objective: workstreamMemory.metadata.objective,
          constraints: workstreamMemory.metadata.constraints,
          blockers: workstreamMemory.metadata.blockers,
          nextActions: workstreamMemory.metadata.nextActions,
          decisions: workstreamMemory.metadata.decisions,
          retainPriorities: workstreamMemory.metadata.retainPriorities,
          reflectPriorities: workstreamMemory.metadata.reflectPriorities,
          status: workstreamMemory.metadata.status,
        },
      ]),
      };
  }

  const semanticMemory = readRetentionSanitizationEnabled(db.config)
    ? sanitizeSemanticMemory(memory ?? {})
    : { ...memory };
  if (!semanticMemory.type || !semanticMemory.content) {
    return {
      id: null,
      kind,
      memory: semanticMemory,
      skipped: true,
      reason: "empty_after_sanitization",
      text: "",
    };
  }

  const id = db.insertSemanticMemory(semanticMemory);
  return {
    id,
    kind,
    memory: semanticMemory,
    skipped: false,
    text: "",
  };
}

export function recallMemory({
  db,
  prompt,
  repository,
  includeOtherRepositories = false,
  limit = 6,
  sessionStore = null,
  promptNeed = null,
}) {
  const need = promptNeed ?? detectPromptContextNeed(prompt);
  if (!readMemoryOperationsEnabled(db.config)) {
    return buildLegacyRecall({
      db,
      prompt,
      repository,
      includeOtherRepositories,
      limit,
      sessionStore,
      promptNeed: need,
    });
  }

  const base = db.explainPromptContext({
    prompt,
    repository,
    includeOtherRepositories,
    limit,
    sessionStore,
    promptNeed: need,
  });

  const workstreamLookup = findRelevantWorkstreamOverlays({
    db,
    prompt,
    repository,
    includeOtherRepositories,
    promptNeed: need,
    config: db.config,
    limit: Math.max(1, Math.min(2, limit)),
  });
  const onboarding = buildOnboardingSection({
    db,
    promptNeed: need,
  });

  const directives = need.identityOnly !== true
    ? fetchDirectives({ db, repository, includeOtherRepositories, config: db.config })
    : { rows: [], text: "", trace: { enabled: false, reason: "identity_only_skip" } };

  const text = [
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

  return {
    prompt,
    repository,
    promptNeed: need,
    text,
    trace: {
      ...base.trace,
      lookups: {
        onboarding: onboarding.trace,
        directives: directives.trace,
        workstreamOverlays: workstreamLookup.trace,
        ...base.trace?.lookups,
      },
      output: {
        ...base.trace?.output,
        sectionTitles,
        estimatedTokens: estimateTokens(text),
      },
    },
    directives: directives.rows,
    overlays: workstreamLookup.overlays,
    estimatedTokens: estimateTokens(text),
  };
}

export function reflectMemory({
  db,
  prompt,
  repository,
  includeOtherRepositories = false,
  limit = 6,
  sessionStore = null,
  promptNeed = null,
  focus = null,
}) {
  const recall = recallMemory({
    db,
    prompt,
    repository,
    includeOtherRepositories,
    limit,
    sessionStore,
    promptNeed,
  });
  const resolvedFocus = detectReflectFocus(prompt, focus);
  const envelope = buildEvidenceEnvelope(recall);
  const selectedEntries = selectReflectEntries(envelope, resolvedFocus);
  const insights = selectedEntries.map((entry) => ({
    text: buildReflectInsight(entry, resolvedFocus),
    source: entry.source,
    lookupName: entry.lookupName,
    kind: entry.kind,
    score: entry.score,
    evidence: truncateText(entry.text, 220),
  }));

  return {
    prompt,
    repository,
    focus: resolvedFocus,
    recall,
    envelope,
    summary: buildReflectSummary({
      focus: resolvedFocus,
      entries: selectedEntries,
      envelope,
    }),
    insights,
  };
}
