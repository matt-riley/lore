import {
  detectAssistantIdentityName,
  detectUserIdentityName,
  MEMORY_SCOPE,
} from "./memory-scope.mjs";
import { readRetentionSanitizationEnabled } from "./rollout-flags.mjs";
import { stripInjectedContext } from "./retention-sanitizer.mjs";

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTurnText(value, config = null) {
  const text = readRetentionSanitizationEnabled(config)
    ? stripInjectedContext(value)
    : String(value || "");
  return normalizeText(text);
}

function stripListMarkers(value) {
  return String(value || "").replace(/^(?:[-*]\s*|\d+[.)]\s*)+/, "").trim();
}

function truncateText(value, limit = 220) {
  const text = normalizeText(value);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function uniqueStrings(values, limit = 8) {
  return [...new Set(values.map(normalizeText).filter(Boolean))].slice(0, limit);
}

function cleanPromptPrefix(value) {
  return normalizeText(value)
    .replace(/^(researching|planning|implementing)\s*:\s*/i, "")
    .replace(/^(please|ok(?:ay)?|hey)\s+/i, "");
}

function isPlaceholderSummary(value) {
  return /^Session [0-9a-f-]{8,}$/i.test(normalizeText(value));
}

function meaningfulSummary(value) {
  const text = cleanPromptPrefix(value);
  if (
    !text
    || isPlaceholderSummary(text)
    || /^call the tool\b/i.test(text)
    || /\breturn only the tool output\b/i.test(text)
    || /^using only local repo files\b/i.test(text)
  ) {
    return "";
  }
  return text;
}

function scoreStructuredLine(value) {
  const text = normalizeText(value).replace(/:\s*$/, "");
  if (!text) {
    return Number.NEGATIVE_INFINITY;
  }
  let score = 0;
  if (/[`_/]/.test(text)) {
    score += 2;
  }
  if (text.length >= 24 && text.length <= 220) {
    score += 1;
  }
  if (/\b(added|updated|extended|refined|implemented|captured|validated|scope|override|audit|backfill|restore|rollback|snapshot|prompt|identity|cross-repo|schema|trace|replay|deferred|memory|coherence)\b/i.test(text)) {
    score += 3;
  }
  if (/\b(the user|the conversation)\b/i.test(text)) {
    score -= 2;
  }
  if (/^(files created|files modified|remaining work|immediate next steps|diagnostics\/validation|files in scope|implementation order)$/i.test(text)) {
    score -= 3;
  }
  return score;
}

function extractOutlineItems(value, { limit = 12 } = {}) {
  const items = [];
  const headings = [];

  for (const rawLine of String(value || "").split("\n")) {
    if (!rawLine.trim()) {
      continue;
    }

    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const level = Math.floor(indent / 2);
    const text = normalizeText(stripListMarkers(rawLine));
    if (!text) {
      continue;
    }

    while (headings.length > 0 && headings.at(-1).level >= level) {
      headings.pop();
    }

    if (/:\s*$/.test(text)) {
      headings.push({
        level,
        text: text.replace(/:\s*$/, ""),
      });
      continue;
    }

    const contextual = headings.length > 0
      ? `${headings.map((entry) => entry.text).join(": ")}: ${text}`
      : text;
    items.push({
      text: contextual,
      score: scoreStructuredLine(contextual),
      order: items.length,
    });
  }

  const seen = new Set();
  const results = [];
  for (const item of items.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.order - right.order;
  })) {
    const key = normalizeText(item.text).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(item.text);
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function summarizePaths(files, limit = 3) {
  return uniqueStrings(
    files
      .map((file) => file.file_path)
      .filter(Boolean)
      .map((filePath) => filePath.split("/").slice(-2).join("/")),
    limit,
  );
}

function summarizeRefs(refs, limit = 2) {
  return uniqueStrings(
    refs.map((ref) => `${ref.ref_type}:${ref.ref_value}`),
    limit,
  );
}

function buildEpisodeSummary({
  sessionId,
  repository,
  session,
  latestCheckpoint,
  turns,
  files,
  refs,
  actions,
  decisions,
  openItems,
  config = null,
}) {
  const seed = [
    meaningfulSummary(latestCheckpoint?.title),
    meaningfulSummary(session.summary),
    meaningfulSummary(normalizeTurnText(turns[0]?.user_message, config)),
    meaningfulSummary(latestCheckpoint?.overview),
    meaningfulSummary(latestCheckpoint?.work_done),
    meaningfulSummary(normalizeTurnText(turns.at(-1)?.assistant_response, config)),
  ].find(Boolean);

  const highlights = uniqueStrings([
    ...decisions.slice(0, 2),
    ...actions.slice(0, 2),
    ...openItems.slice(0, 1),
  ], 2);
  const details = [
    ...highlights,
    summarizePaths(files).length > 0 ? `files: ${summarizePaths(files).join(", ")}` : "",
    summarizeRefs(refs).length > 0 ? `refs: ${summarizeRefs(refs).join(", ")}` : "",
  ].filter(Boolean);

  if (seed) {
    return truncateText(
      `${seed}${details.length > 0 ? ` — ${details.join(" | ")}` : ""}`,
    );
  }

  const location = repository || session.cwd || "local workspace";
  const branch = session.branch ? ` on ${session.branch}` : "";
  if (details.length > 0) {
    return truncateText(`Worked in ${location}${branch} — ${details.join(" | ")}`);
  }
  return `Worked in ${location}${branch || ""} (${sessionId})`;
}

function extractSemanticMemoriesFromTurns(turns, repository, sessionId, config = null) {
  const memories = [];
  const recentTurns = turns.slice(-12);

  for (const turn of recentTurns) {
    const message = normalizeTurnText(turn.user_message, config);
    if (!message || message.length > 240) {
      continue;
    }

    const interactionStyleMemory = extractInteractionStyleMemory({
      message,
      repository,
      sessionId,
      turnIndex: turn.turn_index,
    });
    if (interactionStyleMemory) {
      memories.push(interactionStyleMemory);
      continue;
    }

    if (/\b(?:always|prefer)\b/i.test(message)) {
      memories.push({
        type: "user_preference",
        content: message,
        repository,
        sourceSessionId: sessionId,
        sourceTurnIndex: turn.turn_index,
        confidence: 0.95,
        tags: ["preference", "user"],
      });
      continue;
    }

    if (/\b(?:never|do not|don't)\b/i.test(message)) {
      memories.push({
        type: "rejected_approach",
        content: message,
        repository,
        sourceSessionId: sessionId,
        sourceTurnIndex: turn.turn_index,
        confidence: 0.95,
        tags: ["rejected", "user"],
      });
    }
  }

  return memories;
}

const INTERACTION_STYLE_REQUEST_PATTERNS = [
  /\b(?:talk|speak|respond|reply|sound|be|keep|write|communicate)\b.{0,40}\b(?:to me|with me|more|like|as|tone|voice|style)\b/i,
  /\b(?:please|can you|could you|would you|i(?:'d| would)? like|i prefer|i want|it helps when|feel free to)\b.{0,60}\b(?:tone|voice|style|friendly|warm|colleague|coworker|teammate|collaborative|humou?r|joke)\b/i,
  /\b(?:let'?s|we should)\b.{0,40}\b(?:solve|work|figure|debug|build)\b.{0,20}\btogether\b/i,
];

const INTERACTION_STYLE_COLLEAGUE_PATTERNS = [
  /\bcolleague\b/i,
  /\bcoworker\b/i,
  /\bteam(?: |-)?mate\b/i,
  /\bpeer\b/i,
];

const INTERACTION_STYLE_FRIENDLY_PATTERNS = [
  /\bfriendly\b/i,
  /\bwarm\b/i,
  /\bapproachable\b/i,
  /\bconversational\b/i,
];

const INTERACTION_STYLE_COLLABORATIVE_PATTERNS = [
  /\bcollaborative\b/i,
  /\bcollaborate\b/i,
  /\bwork together\b/i,
  /\bsolve .* together\b/i,
  /\bpartner with me\b/i,
];

const INTERACTION_STYLE_HUMOR_POSITIVE_PATTERNS = [
  /\blight(?:-|\s)?humou?r\b/i,
  /\blittle humou?r\b/i,
  /\bbit of humou?r\b/i,
  /\boccasional (?:humou?r|jokes?)\b/i,
  /\b(?:use|add|include)\b.{0,20}\b(?:humou?r|jokes?)\b/i,
  /\bfeel free to\b.{0,20}\b(?:humou?r|jokes?)\b/i,
];

const INTERACTION_STYLE_HUMOR_NEGATIVE_PATTERNS = [
  /\bno jokes?\b/i,
  /\bskip (?:the )?jokes?\b/i,
  /\bwithout (?:the )?humou?r\b/i,
  /\bkeep it serious\b/i,
];

const INTERACTION_STYLE_NAME_NATURAL_PATTERNS = [
  /\b(?:use|mention|say|include)\s+(?:my\s+)?name\b.{0,30}\b(?:naturally|sparingly|occasionally|when it fits)\b/i,
  /\b(?:naturally|sparingly)\b.{0,20}\b(?:use|mention)\b.{0,20}\b(?:my\s+)?name\b/i,
];

const INTERACTION_STYLE_HUMOR_FREQUENT_PATTERNS = [
  /\b(?:often|frequently|regularly)\b.{0,20}\b(?:humou?r|jokes?)\b/i,
];

const IMPLICIT_CORRECTION_PATTERNS = [
  /^(?:no|nope|nah)\b/i,
  /^not quite\b/i,
  /^(?:that(?:'s| is) wrong|incorrect)\b/i,
  /^(?:actually|instead|rather)\b/i,
  /^(?:still|that still)\b/i,
  /^(?:please\s+)?(?:stop|avoid)\b/i,
  /^(?:please\s+)?use\b.+\binstead\b/i,
  /^(?:i asked|i said|i meant|i wanted)\b/i,
  /^(?:you missed|you ignored|you changed)\b/i,
  /\bshould be\b/i,
  /\bneeds to\b/i,
];

const FAILURE_SIGNAL_PATTERNS = [
  /\b(?:fail(?:ed|ing|ure)?|error(?:ed)?|broken|broke|regress(?:ed|ion)?|crash(?:ed)?|timed?\s*out|timeout|not working|didn'?t work|unable to|could not|cannot|blocked?)\b/i,
  /\bmissing\b.{0,30}\b(?:evidence|artifact|output|file|plan|result|context)\b/i,
];

const FAILURE_RESOLUTION_PATTERNS = [
  /\b(?:fixed|resolved|stabilized|passed|green|included|completed|done|working now)\b/i,
];

function firstMatchingPattern(text, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return pattern;
    }
  }
  return null;
}

function extractInteractionStyleMemory({ message, repository, sessionId, turnIndex }) {
  const requestPattern = firstMatchingPattern(message, INTERACTION_STYLE_REQUEST_PATTERNS);
  if (!requestPattern) {
    return null;
  }

  const hasColleagueSignal = Boolean(firstMatchingPattern(message, INTERACTION_STYLE_COLLEAGUE_PATTERNS));
  const hasFriendlySignal = Boolean(firstMatchingPattern(message, INTERACTION_STYLE_FRIENDLY_PATTERNS));
  const hasCollaborativeSignal = Boolean(firstMatchingPattern(message, INTERACTION_STYLE_COLLABORATIVE_PATTERNS));
  const hasHumorPositiveSignal = Boolean(firstMatchingPattern(message, INTERACTION_STYLE_HUMOR_POSITIVE_PATTERNS));
  const hasHumorNegativeSignal = Boolean(firstMatchingPattern(message, INTERACTION_STYLE_HUMOR_NEGATIVE_PATTERNS));
  const useNameNaturally = Boolean(firstMatchingPattern(message, INTERACTION_STYLE_NAME_NATURAL_PATTERNS));

  if (
    !hasColleagueSignal
    && !hasFriendlySignal
    && !hasCollaborativeSignal
    && !hasHumorPositiveSignal
    && !hasHumorNegativeSignal
    && !useNameNaturally
  ) {
    return null;
  }

  const profile = {
    voice: hasColleagueSignal
      ? "colleague"
      : hasCollaborativeSignal
        ? "collaborative"
        : "friendly",
    warmth: hasFriendlySignal ? "warm" : "balanced",
    humor: hasHumorNegativeSignal ? "none" : hasHumorPositiveSignal ? "light" : "none",
    humorFrequency: hasHumorNegativeSignal
      ? "never"
      : hasHumorPositiveSignal
        ? firstMatchingPattern(message, INTERACTION_STYLE_HUMOR_FREQUENT_PATTERNS) ? "frequent" : "occasional"
        : "never",
    collaborative: hasCollaborativeSignal || hasColleagueSignal,
    useNameNaturally,
  };

  return {
    type: "interaction_style",
    content: `Interaction style preference: ${message}`,
    repository: null,
    scope: MEMORY_SCOPE.GLOBAL,
    sourceSessionId: sessionId,
    sourceTurnIndex: turnIndex,
    confidence: 0.92,
    tags: uniqueStrings([
      "interaction-style",
      profile.voice,
      profile.warmth,
      profile.humor,
      profile.collaborative ? "collaborative" : "",
      profile.useNameNaturally ? "use-name-naturally" : "",
    ], 6),
    metadata: {
      source: "rule_extractor",
      profile,
      patternType: "direct_or_soft",
      requestPattern: requestPattern.toString(),
    },
  };
}

function extractAssistantIdentityMemories(turns, sessionId) {
  const memories = [];
  const recentTurns = turns.slice(-12);
  for (const turn of recentTurns) {
    const message = normalizeTurnText(turn.user_message);
    const assistantName = detectAssistantIdentityName(message);
    if (!assistantName) {
      continue;
    }
    memories.push({
      type: "assistant_identity",
      content: `The user calls the assistant ${assistantName}.`,
      repository: null,
      scope: MEMORY_SCOPE.GLOBAL,
      sourceSessionId: sessionId,
      sourceTurnIndex: turn.turn_index,
      confidence: 0.99,
      tags: ["assistant-identity", "user", assistantName.toLowerCase()],
      metadata: {
        source: "rule_extractor",
        assistantName,
      },
    });
  }
  return memories;
}

function extractUserIdentityMemories(turns, repository, sessionId) {
  const memories = [];
  const seenNames = new Set();
  const recentTurns = turns.slice(-12);
  for (const turn of recentTurns) {
    const message = normalizeTurnText(turn.user_message);
    const preferredName = detectUserIdentityName(message);
    const key = preferredName?.toLowerCase();
    if (!preferredName || seenNames.has(key)) {
      continue;
    }
    seenNames.add(key);
    memories.push({
      type: "user_identity",
      content: `The user's preferred name is ${preferredName}.`,
      repository,
      scope: MEMORY_SCOPE.GLOBAL,
      sourceSessionId: sessionId,
      sourceTurnIndex: turn.turn_index,
      confidence: 0.99,
      tags: ["user-identity", "user", "preferred-name"],
      metadata: {
        source: "rule_extractor",
        preferredName,
      },
    });
  }
  return memories;
}

function extractAssistantGoalMemories(turns, repository, sessionId, config = null) {
  const memories = [];
  const seen = new Set();
  const recentTurns = turns.slice(-12);
  for (const turn of recentTurns) {
    const message = normalizeTurnText(turn.user_message, config);
    if (!message || message.length > 240) {
      continue;
    }
    const match = message.match(
      /\b(?:goal(?:\s+for\s+this\s+session)?\s+is|i(?:\s+am|'m)\s+(?:trying|aiming)\s+to|help me)\s+(.+)$/i,
    );
    const goal = normalizeText(match?.[1] ?? "");
    if (!goal || goal.length < 10) {
      continue;
    }
    const key = goal.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    memories.push({
      type: "assistant_goal",
      content: `Current assistant goal: ${goal}`,
      repository,
      sourceSessionId: sessionId,
      sourceTurnIndex: turn.turn_index,
      confidence: 0.85,
      tags: ["assistant-goal", "session-goal", "user"],
      metadata: {
        source: "rule_extractor",
        goal,
      },
    });
  }
  return memories;
}

function extractRecurringMistakeMemories(turns, sessionId, config = null) {
  const memories = [];
  const seen = new Set();
  const recentTurns = turns.slice(-20);
  for (const turn of recentTurns) {
    const message = normalizeTurnText(turn.user_message, config);
    if (!message || message.length > 260) {
      continue;
    }
    const match = message.match(
      /\b(?:you keep|you always|again(?:\s+you)?|same mistake|repeating)\b[:\s-]*(.+)$/i,
    );
    const mistake = normalizeText(match?.[1] ?? "");
    if (!mistake || mistake.length < 8) {
      continue;
    }
    const key = mistake.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    memories.push({
      type: "recurring_mistake",
      content: `Recurring mistake to avoid: ${mistake}`,
      repository: null,
      scope: MEMORY_SCOPE.GLOBAL,
      sourceSessionId: sessionId,
      sourceTurnIndex: turn.turn_index,
      confidence: 0.9,
      tags: ["recurring-mistake", "feedback", "user"],
      metadata: {
        source: "rule_extractor",
        mistake,
      },
    });
  }
  return memories;
}

function stripImplicitCorrectionLead(value) {
  return normalizeText(value)
    .replace(/^(?:no|nope|nah)\b[:\s-]*/i, "")
    .replace(/^not quite\b[:\s-]*/i, "")
    .replace(/^(?:that(?:'s| is) wrong|incorrect)\b[:\s-]*/i, "")
    .replace(/^(?:actually|instead|rather)\b[:\s-]*/i, "")
    .replace(/^(?:still|that still)\b[:\s-]*/i, "")
    .replace(/^(?:please\s+)?(?:stop|avoid)\b[:\s-]*/i, "")
    .replace(/^(?:please\s+)?use\b[:\s-]*/i, "")
    .replace(/^(?:i asked|i said|i meant|i wanted)\b[:\s-]*/i, "")
    .replace(/^(?:you missed|you ignored|you changed)\b[:\s-]*/i, "")
    .replace(/^[,;:. -]+/, "")
    .trim();
}

function collectImplicitCorrectionSignals(turns, config = null) {
  const signals = [];
  for (const turn of turns.slice(-20)) {
    const message = normalizeTurnText(turn.user_message, config);
    if (!message || message.length > 280) {
      continue;
    }
    if (!firstMatchingPattern(message, IMPLICIT_CORRECTION_PATTERNS)) {
      continue;
    }
    const cleaned = stripImplicitCorrectionLead(message);
    if (!cleaned || cleaned.length < 12) {
      continue;
    }
    signals.push({
      turnIndex: turn.turn_index,
      text: truncateText(cleaned, 140),
    });
  }
  return signals;
}

function inferRecurringMistakeFromCorrections(turns, sessionId, config = null) {
  const signals = collectImplicitCorrectionSignals(turns, config);
  if (signals.length < 2) {
    return null;
  }
  const examples = uniqueStrings(signals.map((signal) => signal.text), 3);
  const mistake = "missing or overriding explicit user corrections before continuing implementation";
  return {
    type: "recurring_mistake",
    content: `Recurring mistake to avoid: ${mistake}.`,
    repository: null,
    scope: MEMORY_SCOPE.GLOBAL,
    sourceSessionId: sessionId,
    sourceTurnIndex: signals.at(-1)?.turnIndex ?? null,
    confidence: 0.93,
    tags: ["recurring-mistake", "feedback", "implicit-session", "correction-pattern"],
    metadata: {
      source: "implicit_session_inference",
      signalType: "repeated_correction",
      mistake,
      correctionCount: signals.length,
      examples,
    },
  };
}

function collectFailureSignals({ turns, actions, decisions, openItems, config = null }) {
  const sources = [
    ...turns.slice(-16).flatMap((turn) => [
      { turnIndex: turn.turn_index, text: normalizeTurnText(turn.user_message, config) },
      { turnIndex: turn.turn_index, text: normalizeTurnText(turn.assistant_response, config) },
    ]),
    ...actions.map((text) => ({ turnIndex: null, text: normalizeText(text) })),
    ...decisions.map((text) => ({ turnIndex: null, text: normalizeText(text) })),
    ...openItems.map((text) => ({ turnIndex: null, text: normalizeText(text) })),
  ];

  const signals = [];
  for (const source of sources) {
    if (!source.text || source.text.length > 280) {
      continue;
    }
    if (!firstMatchingPattern(source.text, FAILURE_SIGNAL_PATTERNS)) {
      continue;
    }
    if (firstMatchingPattern(source.text, FAILURE_RESOLUTION_PATTERNS)) {
      continue;
    }
    signals.push({
      turnIndex: source.turnIndex,
      text: truncateText(source.text, 140),
    });
  }
  return uniqueStrings(signals.map((signal) => signal.text), 4).map((text) => ({
    text,
    turnIndex: signals.find((signal) => signal.text === text)?.turnIndex ?? null,
  }));
}

function classifyImplicitFailureGoal(examples) {
  const corpus = examples.join(" ").toLowerCase();
  if (/\b(?:replay|ranking|validation|assert|test)\b/.test(corpus)) {
    return "stabilize failing validation and replay coverage before shipping";
  }
  if (/\b(?:backfill|rollback|restore|snapshot|schema|migration)\b/.test(corpus)) {
    return "stabilize migration and recovery paths before broader rollout";
  }
  if (/\b(?:prompt|persona|style|identity|override)\b/.test(corpus)) {
    return "stabilize prompt-shaping and persona behavior before continuing rollout";
  }
  if (/\b(?:build|lint|typecheck|compile|command|workflow|action)\b/.test(corpus)) {
    return "stabilize failing execution paths before continuing implementation";
  }
  return "stabilize repeated failure paths before continuing implementation";
}

function inferAssistantGoalFromFailures({ turns, repository, sessionId, actions, decisions, openItems, config = null }) {
  const signals = collectFailureSignals({ turns, actions, decisions, openItems, config });
  if (signals.length < 2) {
    return null;
  }
  const examples = signals.map((signal) => signal.text);
  const goal = classifyImplicitFailureGoal(examples);
  return {
    type: "assistant_goal",
    content: `Current assistant goal: ${goal}`,
    repository,
    sourceSessionId: sessionId,
    sourceTurnIndex: signals.at(-1)?.turnIndex ?? null,
    confidence: 0.82,
    tags: ["assistant-goal", "implicit-session", "failure-repair"],
    metadata: {
      source: "implicit_session_inference",
      signalType: "repeated_failure",
      goal,
      failureCount: signals.length,
      examples,
    },
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function extractThemes(summary, repository) {
  const words = normalizeText(summary)
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4)
    .slice(0, 5);
  const repoBits = repository ? repository.split(/[/:_-]/).filter(Boolean).slice(-2) : [];
  return [...new Set([...repoBits, ...words])].slice(0, 8);
}

function extractActions({ latestCheckpoint, files }) {
  return uniqueStrings([
    ...extractOutlineItems(latestCheckpoint?.work_done, { limit: 10 }),
    ...extractOutlineItems(latestCheckpoint?.history, { limit: 6 }),
    ...files.map((file) => file.file_path).filter(Boolean),
  ], 12);
}

function extractDecisions(latestCheckpoint) {
  return uniqueStrings([
    ...extractOutlineItems(latestCheckpoint?.technical_details, { limit: 12 }),
    ...extractOutlineItems(latestCheckpoint?.work_done, { limit: 8 }),
    ...extractOutlineItems(latestCheckpoint?.overview, { limit: 6 }),
  ], 14);
}

function extractOpenItems(latestCheckpoint) {
  return uniqueStrings(extractOutlineItems(latestCheckpoint?.next_steps, { limit: 10 }), 10);
}

export function extractSessionMemories({ sessionId, repository, sessionArtifacts, workspace, config = null }) {
  const { session, checkpoints, files, refs, turns } = sessionArtifacts;
  const latestCheckpoint = checkpoints[0] ?? null;
  const effectiveRepository = repository
    ?? session.repository
    ?? workspace.workspace?.repository
    ?? null;
  const actions = extractActions({ latestCheckpoint, files });
  const decisions = extractDecisions(latestCheckpoint);
  const openItems = extractOpenItems(latestCheckpoint);
  const summary = buildEpisodeSummary({
    sessionId,
    repository: effectiveRepository,
    session,
    latestCheckpoint,
    turns,
    files,
    refs,
    actions,
    decisions,
    openItems,
    config,
  });
  const learnings = extractSemanticMemoriesFromTurns(turns, effectiveRepository, sessionId, config).map((item) => item.content);
  const assistantGoalMemories = extractAssistantGoalMemories(turns, effectiveRepository, sessionId, config);
  const recurringMistakeMemories = extractRecurringMistakeMemories(turns, sessionId, config);
  const implicitAssistantGoal = assistantGoalMemories.length === 0
    ? inferAssistantGoalFromFailures({
      turns,
      repository: effectiveRepository,
      sessionId,
      actions,
      decisions,
      openItems,
      config,
    })
    : null;
  const implicitRecurringMistake = recurringMistakeMemories.length === 0
    ? inferRecurringMistakeFromCorrections(turns, sessionId, config)
    : null;
  const themes = extractThemes(
    [summary, ...actions.slice(0, 3), ...decisions.slice(0, 2), ...openItems.slice(0, 2)].join(" "),
    effectiveRepository,
  );

  const significance = clamp(
    3
      + Math.min(files.length, 3)
      + Math.min(refs.length, 2)
      + (latestCheckpoint ? 1 : 0)
      + (session.summary ? 1 : 0),
    1,
    10,
  );

  const createdAt = session.updated_at || workspace.workspace?.updated_at || new Date().toISOString();
  const dateKey = createdAt.slice(0, 10);

  return {
    episodeDigest: {
      id: sessionId,
      sessionId,
      repository: effectiveRepository,
      branch: session.branch ?? workspace.workspace?.branch ?? null,
      summary,
      actions,
      decisions,
      learnings,
      filesChanged: files.map((file) => file.file_path),
      refs: refs.map((ref) => `${ref.ref_type}:${ref.ref_value}`),
      significance,
      themes,
      openItems,
      source: "rule",
      dateKey,
      createdAt,
    },
    semanticMemories: [
      ...extractAssistantIdentityMemories(turns, sessionId),
      ...extractUserIdentityMemories(turns, effectiveRepository, sessionId),
      ...assistantGoalMemories,
      ...(implicitAssistantGoal ? [implicitAssistantGoal] : []),
      ...recurringMistakeMemories,
      ...(implicitRecurringMistake ? [implicitRecurringMistake] : []),
      ...extractSemanticMemoriesFromTurns(turns, effectiveRepository, sessionId),
      ...openItems.map((item) => ({
        type: "open_loop",
        content: item,
        repository: effectiveRepository,
        sourceSessionId: sessionId,
        confidence: 0.8,
        tags: ["open-loop", "checkpoint"],
      })),
    ],
  };
}
