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

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

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
        ...(base.trace?.lookups ?? {}),
      },
      output: {
        ...(base.trace?.output ?? {}),
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
  const counts = new Map();
  for (const item of Array.isArray(filtered) ? filtered : []) {
    const key = String(item?.reason || "filtered");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => `${reason} x${count}`);
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

export function buildEvidenceEnvelope(result) {
  const lookups = Object.entries(result?.trace?.lookups ?? {}).map(([name, lookup]) => {
    const matchedRows = Array.isArray(lookup?.rows) ? lookup.rows : [];
    const rankedRows = Array.isArray(lookup?.rankedRows) ? lookup.rankedRows : [];
    const includedRows = Array.isArray(lookup?.includedRows) ? lookup.includedRows : [];
    const sourceLabel = humanizeLookupName(name);
    const includedEntries = buildLookupEvidenceEntries(includedRows, {
      lookupName: name,
      bucket: "included",
      sourceLabel,
    });
    const matchedEntries = buildLookupEvidenceEntries(matchedRows, {
      lookupName: name,
      bucket: "matched",
      sourceLabel,
    });
    const rankedEntries = buildLookupEvidenceEntries(rankedRows, {
      lookupName: name,
      bucket: "ranked",
      sourceLabel,
    });
    return {
      name,
      label: sourceLabel,
      enabled: lookup?.enabled !== false,
      reason: lookup?.reason ?? null,
      matchedCount: matchedRows.length || rankedRows.length,
      includedCount: includedRows.length,
      filteredReasons: aggregateFilteredReasons(lookup?.filtered),
      includedEntries,
      matchedEntries,
      rankedEntries,
    };
  });

  const supportingFacts = dedupeStrings(
    lookups.flatMap((lookup) => lookup.includedEntries.map((entry) => entry.text)),
    8,
  );
  const sourceAccounting = Array.isArray(result?.trace?.output?.sectionDetails)
    ? result.trace.output.sectionDetails.map((detail) => ({
        title: detail?.title ?? "section",
        source: detail?.source ?? null,
        budget: detail?.budget ?? null,
        usedTokens: detail?.usedTokens ?? 0,
        entryCount: detail?.entryCount ?? 0,
      }))
    : [];
  const evidenceEntries = dedupeEvidenceEntries(
    lookups.flatMap((lookup) => (
      lookup.includedEntries.length > 0
        ? lookup.includedEntries
        : lookup.matchedEntries.length > 0
          ? lookup.matchedEntries.slice(0, 2)
          : lookup.rankedEntries.slice(0, 2)
    )),
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

export function detectReflectFocus(prompt, requestedFocus = null) {
  if (requestedFocus === REFLECT_FOCUS.PATTERNS
    || requestedFocus === REFLECT_FOCUS.BLOCKERS
    || requestedFocus === REFLECT_FOCUS.DECISIONS
    || requestedFocus === REFLECT_FOCUS.NEXT_ACTIONS
    || requestedFocus === REFLECT_FOCUS.SUMMARY) {
    return requestedFocus;
  }

  const text = normalizeText(prompt).toLowerCase();
  if (BLOCKER_SIGNAL_PATTERN.test(text)) {
    return REFLECT_FOCUS.BLOCKERS;
  }
  if (NEXT_ACTION_SIGNAL_PATTERN.test(text)) {
    return REFLECT_FOCUS.NEXT_ACTIONS;
  }
  if (DECISION_SIGNAL_PATTERN.test(text)) {
    return REFLECT_FOCUS.DECISIONS;
  }
  if (PATTERN_SIGNAL_PATTERN.test(text) || /\bwhat do you see\b/.test(text)) {
    return REFLECT_FOCUS.PATTERNS;
  }
  return REFLECT_FOCUS.SUMMARY;
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
    if (overlay.mission) {
      entries.push({
        lookupName: "workstreamOverlays",
        bucket: "included",
        index: entries.length,
        text: overlay.mission,
        row,
        source,
        kind: "mission",
        repository,
        crossRepo: false,
      });
    }
    if (overlay.objective) {
      entries.push({
        lookupName: "workstreamOverlays",
        bucket: "included",
        index: entries.length,
        text: overlay.objective,
        row,
        source,
        kind: "objective",
        repository,
        crossRepo: false,
      });
    }
    for (const [index, item] of overlay.constraints.entries()) {
      entries.push({
        lookupName: "workstreamOverlays",
        bucket: "included",
        index,
        text: item,
        row,
        source,
        kind: "constraint",
        repository,
        crossRepo: false,
      });
    }
    for (const [index, item] of overlay.blockers.entries()) {
      entries.push({
        lookupName: "workstreamOverlays",
        bucket: "included",
        index,
        text: item,
        row,
        source,
        kind: "blocker",
        repository,
        crossRepo: false,
      });
    }
    for (const [index, item] of overlay.nextActions.entries()) {
      entries.push({
        lookupName: "workstreamOverlays",
        bucket: "included",
        index,
        text: item,
        row,
        source,
        kind: "next_action",
        repository,
        crossRepo: false,
      });
    }
    for (const [index, item] of overlay.decisions.entries()) {
      entries.push({
        lookupName: "workstreamOverlays",
        bucket: "included",
        index,
        text: item,
        row,
        source,
        kind: "decision",
        repository,
        crossRepo: false,
      });
    }
    for (const [index, item] of overlay.reflectPriorities.entries()) {
      entries.push({
        lookupName: "workstreamOverlays",
        bucket: "included",
        index,
        text: item,
        row,
        source,
        kind: "reflect_priority",
        repository,
        crossRepo: false,
      });
    }
  }
  return entries;
}

function matchesReflectFocus(entry, focus) {
  if (focus === REFLECT_FOCUS.SUMMARY) {
    return true;
  }
  const text = entry.text.toLowerCase();
  if (focus === REFLECT_FOCUS.BLOCKERS) {
    return entry.kind === "blocker"
      || entry.kind === "constraint"
      || BLOCKER_SIGNAL_PATTERN.test(text);
  }
  if (focus === REFLECT_FOCUS.DECISIONS) {
    return entry.kind === "decision"
      || entry.kind === "reflect_priority"
      || ["rejected_approach", "user_preference", "recurring_mistake"].includes(entry.kind)
      || DECISION_SIGNAL_PATTERN.test(text);
  }
  if (focus === REFLECT_FOCUS.NEXT_ACTIONS) {
    return entry.kind === "next_action"
      || entry.kind === "objective"
      || entry.kind === "mission"
      || ["open_loop", "assistant_goal", "commitment"].includes(entry.kind)
      || NEXT_ACTION_SIGNAL_PATTERN.test(text);
  }
  return entry.kind === "reflect_priority"
    || entry.kind === "decision"
    || entry.kind === "blocker"
    || PATTERN_SIGNAL_PATTERN.test(text);
}

function scoreReflectEntry(entry, focus) {
  let score = 0;
  if (entry.lookupName === "workstreamOverlays") {
    score += 5;
  }
  if (entry.bucket === "included") {
    score += 4;
  } else if (entry.bucket === "matched") {
    score += 2;
  } else {
    score += 1;
  }
  if (matchesReflectFocus(entry, focus)) {
    score += 6;
  }
  if (focus === REFLECT_FOCUS.PATTERNS && entry.kind === "reflect_priority") {
    score += 4;
  }
  if (focus === REFLECT_FOCUS.BLOCKERS && entry.kind === "blocker") {
    score += 4;
  }
  if (focus === REFLECT_FOCUS.DECISIONS && entry.kind === "decision") {
    score += 4;
  }
  if (focus === REFLECT_FOCUS.NEXT_ACTIONS && entry.kind === "next_action") {
    score += 4;
  }
  if (entry.crossRepo) {
    score -= 1;
  }
  return score - (entry.index ?? 0) * 0.1;
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

function buildReflectSummary({ focus, entries, envelope }) {
  if (focus === REFLECT_FOCUS.PATTERNS) {
    const highlights = buildPatternHighlights(entries);
    if (highlights.length > 0) {
      return `Retrieved evidence clusters around ${joinNaturalList(highlights)}.`;
    }
    const fallbackHighlights = dedupeStrings(entries.map((entry) => truncateText(entry.text, 72)), 3);
    if (fallbackHighlights.length > 0) {
      return `Retrieved evidence repeatedly points to ${joinNaturalList(fallbackHighlights)}.`;
    }
  }
  const highlights = dedupeStrings(entries.map((entry) => truncateText(entry.text, 72)), 3);
  if (focus === REFLECT_FOCUS.BLOCKERS) {
    return highlights.length > 0
      ? `Current blockers center on ${joinNaturalList(highlights)}.`
      : envelope.workstreamOverlays.length > 0
        ? "No explicit blockers were retained in the active workstream overlays."
        : "No explicit blockers were found in the retrieved evidence.";
  }
  if (focus === REFLECT_FOCUS.DECISIONS) {
    return highlights.length > 0
      ? `The strongest retained decisions are ${joinNaturalList(highlights)}.`
      : "No durable decisions stood out in the retrieved evidence.";
  }
  if (focus === REFLECT_FOCUS.NEXT_ACTIONS) {
    return highlights.length > 0
      ? `The next concrete actions are ${joinNaturalList(highlights)}.`
      : envelope.workstreamOverlays.length > 0
        ? "The active workstream does not currently retain explicit next actions."
        : "No explicit next actions were found in the retrieved evidence.";
  }
  return highlights.length > 0
    ? `Retrieved context emphasizes ${joinNaturalList(highlights)}.`
    : "No reflection-worthy evidence was retrieved for this prompt.";
}

function buildReflectInsight(entry, focus) {
  if (focus === REFLECT_FOCUS.BLOCKERS) {
    const label = entry.kind === "constraint" ? "Constraint" : "Blocker";
    return `${label}: ${truncateText(entry.text)}`;
  }
  if (focus === REFLECT_FOCUS.DECISIONS) {
    const label = entry.kind === "reflect_priority" ? "Priority" : "Decision";
    return `${label}: ${truncateText(entry.text)}`;
  }
  if (focus === REFLECT_FOCUS.NEXT_ACTIONS) {
    const label = entry.kind === "objective" || entry.kind === "mission" ? "Direction" : "Next action";
    return `${label}: ${truncateText(entry.text)}`;
  }
  if (focus === REFLECT_FOCUS.PATTERNS) {
    const label = entry.kind === "reflect_priority" ? "Pattern" : "Signal";
    return `${label}: ${truncateText(entry.text)}`;
  }
  return truncateText(entry.text);
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
    : { ...(memory ?? {}) };
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

  const directives = need.identityOnly !== true
    ? fetchDirectives({ db, repository, includeOtherRepositories, config: db.config })
    : { rows: [], text: "", trace: { enabled: false, reason: "identity_only_skip" } };

  const text = [
    directives.text,
    workstreamLookup.text,
    base.text,
  ].filter(Boolean).join("\n\n");
  const baseSections = Array.isArray(base.trace?.output?.sectionTitles)
    ? base.trace.output.sectionTitles
    : [];
  const sectionTitles = [
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
        directives: directives.trace,
        workstreamOverlays: workstreamLookup.trace,
        ...(base.trace?.lookups ?? {}),
      },
      output: {
        ...(base.trace?.output ?? {}),
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
