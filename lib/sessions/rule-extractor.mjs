import {
  detectAssistantIdentityDeclaration,
  detectUserIdentityName,
  MEMORY_SCOPE,
} from "../memory/memory-scope.mjs";
import { createHash } from "node:crypto";
import { normalizeText } from "../utils/text-normalizer.mjs";
import { readRetentionSanitizationEnabled } from "../rollout/rollout-flags.mjs";
import { stripInjectedContext } from "../memory/retention-sanitizer.mjs";

function normalizeTurnText(value, config = null) {
  const text = readRetentionSanitizationEnabled(config)
    ? stripInjectedContext(value)
    : String(value || "");
  return normalizeText(text);
}

function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeEvidenceText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/["'’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(value) {
  const sentences = [];
  let current = "";
  let quote = null;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    current += character;
    if (character === '"') {
      quote = quote === '"' ? null : (quote ?? '"');
    } else if (character === "“") {
      quote = "”";
    } else if (character === "”" && quote === "”") {
      quote = null;
    } else if (character === "‘") {
      quote = "’";
    } else if (character === "’" && quote === "’") {
      quote = null;
    }
    if (!quote && /["”’]/.test(character) && /[.!?;]/.test(text[index - 1] ?? "")
      && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      const sentence = normalizeText(current);
      if (sentence) {
        sentences.push(sentence);
      }
      current = "";
      continue;
    }
    if (!quote && /[.!?;]/.test(character) && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      const sentence = normalizeText(current);
      if (sentence) {
        sentences.push(sentence);
      }
      current = "";
    }
  }
  const remainder = normalizeText(current);
  if (remainder) {
    sentences.push(remainder);
  }
  return sentences;
}

function splitDirectiveClauses(sentence) {
  return sentence
    .split(/\s+(?:and|but)\s+(?=(?:never|do\s+not|don't|avoid|please)\b)|\s+so\s+(?=please\s+(?:use|prefer|keep|include)\b)/i)
    .map((clause) => clause.replace(/;+$/, "").trim())
    .filter(Boolean);
}

function isQuotedSentence(text) {
  const quoteRanges = [];
  const quotePattern = /["“”‘’]/g;
  let openQuote = null;
  for (const match of text.matchAll(quotePattern)) {
    const quote = match[0];
    if (quote === "“" || quote === "‘" || (quote === '"' && openQuote === null)) {
      openQuote = match.index;
      continue;
    }
    if (openQuote !== null) {
      quoteRanges.push([openQuote, match.index + 1]);
      openQuote = null;
    }
  }
  if (openQuote !== null) {
    quoteRanges.push([openQuote, text.length]);
  }
  return quoteRanges.length > 0;
}

function isNonDirectiveSentence(text) {
  return !text
    || text.endsWith("?")
    || isQuotedSentence(text)
    || /^(?:if|unless|when|suppose|imagine|assuming|should we|could we|would you|could you|can you|what if)\b/i.test(text)
    || /\b(?:don't|do not|never|not)\s+(?:really\s+)?prefer\b/i.test(text)
    || /\bprefer\s+not\s+to\b/i.test(text)
    || /\bi\s+meant\s+to\s+(?:ask|know|understand)\b/i.test(text)
    || /\b(?:would|could|might|may)\s+(?:prefer|use|choose|avoid)\b/i.test(text);
}

const EXPLICIT_SCOPE_PREAMBLE_PATTERN = /^(?:(?:for|in)\s+(?:this|the current)(?:\s+[a-z][a-z0-9_-]*){0,2}\s+(?:repo(?:sitory)?|project|app)|for\s+[a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,4}|(?:across|in|for)\s+all\s+(?:of\s+)?(?:my\s+)?(?:projects|repositories|repos)|make\s+(?:this\s+)?rule\s+global\s+across\s+(?:all\s+)?(?:projects|repositories|repos)|globally)\s*(?:,|:)\s*/i;

function directiveBody(text) {
  return String(text || "")
    .replace(EXPLICIT_SCOPE_PREAMBLE_PATTERN, "")
    .replace(/^actually\s*,?\s*(?:that(?:'s| is)\s+wrong\s*:\s*)/i, "");
}

function isConditionalDirectiveSentence(text) {
  return /\b(?:if|unless|when)\b/i.test(text);
}

const EXPLICIT_PREFERENCE_PATTERNS = [
  /^(?:i|we)\s+(?:always\s+)?(?:really\s+)?prefer\s+.+$/i,
  /^(?:please\s+)?prefer\s+.+$/i,
  /^my\s+preference\s+is\s+.+$/i,
  /^(?:please\s+)?always\s+(?:use|keep|include|show|run|write|ask|check|preserve|make)\s+.+$/i,
  /^(?:i|we)\s+always\s+(?:use|keep|include|show|run|write|ask|check|preserve|make)\s+.+$/i,
  /^please\s+(?:use|keep|include|show|run|write|ask|check|preserve|make)\s+.+$/i,
  /^(?:i|we)\s+work\s+best\s+with\s+.+$/i,
  /^(?:across|in)\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?projects?\s+i\s+work\s+best\s+with\s+.+$/i,
  /^(?:no\s*,?\s*)?i\s+meant\s+.+$/i,
  /^remember\s+.+\b(?:decision|rule)\s*:\s*.+$/i,
  /^split\s+(?:changes|commits)\b.+$/i,
  /^(?:please\s+)?(?:use|keep|include|show|run|write|ask|check|preserve|make)\s+.+\s+(?:for|when|in)\s+(?:this|the)\s+(?:repo|repository|project)\b.*$/i,
  /^please\s+(?:keep|make|write|format)\s+.+$/i,
];

const EXPLICIT_REJECTION_PATTERNS = [
  /^(?:please\s+)?(?:do not|don't|never)\s+(?:ever\s+)?(?:use|store|include|show|run|write|ask|check|preserve|make|put|retain|drop|remove|retry|commit|push|delete|merge|overwrite|ignore|assume|send|expose|log|add|change|modify|rely|return|start)\b.+$/i,
  /^(?:please\s+)?avoid\s+.+$/i,
  /^(?:please\s+)?stop\s+.+$/i,
  /^(?:i|we)\s+(?:do not|don't|never)\s+(?:want|like|use|need|store|include|see)\s+.+$/i,
];

const EXPLICIT_GLOBAL_SCOPE_PATTERN = /\b(?:globally|across\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?(?:projects|repositories|repos)|for\s+(?:every|all)\s+(?:my\s+)?(?:project|repository|repo)|regardless\s+of\s+(?:the\s+)?repo(?:sitory)?|in\s+all\s+(?:of\s+)?(?:my\s+)?(?:projects|repositories|repos))\b/i;

function hasExplicitDirective(text, patterns) {
  const body = directiveBody(text);
  const correctionLead = /^actually\s*,?\s*(?:that(?:'s| is)\s+wrong\s*:\s*)/i.test(text);
  return !isNonDirectiveSentence(text)
    && !isConditionalDirectiveSentence(text)
    && (patterns.some((pattern) => pattern.test(body))
      || (patterns === EXPLICIT_PREFERENCE_PATTERNS
        && correctionLead
        && /^use\s+.+$/i.test(body)));
}

function scopeForExtractedDirective(text, repository) {
  if (EXPLICIT_GLOBAL_SCOPE_PATTERN.test(text)) {
    return {
      scope: MEMORY_SCOPE.GLOBAL,
      repository: null,
      scopeMetadata: repository ? { originRepository: repository } : {},
    };
  }
  if (repository) {
    return { scope: MEMORY_SCOPE.REPO, repository };
  }
  return {};
}

function buildDirectiveMemory({ sentence, type, repository, sessionId, turn, sourceRole }) {
  const scope = scopeForExtractedDirective(sentence, repository);
  const rejection = type === "rejected_approach";
  const { scopeMetadata, ...scopeFields } = scope;
  return {
    type,
    content: sentence,
    ...scopeFields,
    sourceSessionId: sessionId,
    sourceTurnIndex: turn.turn_index,
    confidence: rejection ? 0.76 : 0.78,
    tags: rejection ? ["rejected", sourceRole] : ["preference", sourceRole],
    metadata: {
      ...scopeMetadata,
      source: "rule_extractor",
      sourceRole,
      confidenceBasis: rejection ? "explicit_rejection_sentence" : "explicit_preference_sentence",
    },
  };
}

export function extractDirectiveMemoriesFromTurn({ turn, text, repository, sessionId, sourceRole }) {
  const memories = [];
  for (const rawSentence of splitSentences(text)) {
    for (const sentence of splitDirectiveClauses(rawSentence)) {
      const contentSentence = /^please\s/i.test(sentence) && /\bso\b/i.test(rawSentence)
        ? rawSentence
        : sentence;
      if (hasExplicitDirective(sentence, EXPLICIT_PREFERENCE_PATTERNS)) {
        memories.push(buildDirectiveMemory({
          sentence: contentSentence,
          type: "user_preference",
          repository,
          sessionId,
          turn,
          sourceRole,
        }));
      }
      if (hasExplicitDirective(sentence, EXPLICIT_REJECTION_PATTERNS)) {
        memories.push(buildDirectiveMemory({
          sentence: contentSentence,
          type: "rejected_approach",
          repository,
          sessionId,
          turn,
          sourceRole,
        }));
      }
    }
  }
  return memories;
}

const DECISION_PATTERNS = [
  /^(?:we|i)\s+(?:have\s+)?decided\s+to\s+(.+?)(?:\s+because\s+(.+))?$/i,
  /^(?:we|i)\s+(?:chose|selected|settled\s+on)\s+(.+?)(?:\s+because\s+(.+))?$/i,
  /^(?:we|i)\s+(?:changed|switched|moved)\s+to\s+(.+?)(?:\s+because\s+(.+))?$/i,
  /^.*\b(?:we|i)\s+(?:chose|selected|settled\s+on)\s+(.+?)(?:\s+because\s+(.+))?$/i,
  /^the\s+decision\s+changed\b.*?:\s*(?:use|choose)\s+(.+?)(?:\s+because\s+(.+))?$/i,
  /^the\s+decision\s+is\s+to\s+(.+?)(?:\s+because\s+(.+))?$/i,
];

export function extractDecisionMemoryFromTurn({ turn, text, repository, sessionId, sourceRole }) {
  const memories = [];
  for (const sentence of splitSentences(text)) {
    if (isNonDirectiveSentence(sentence)) {
      continue;
    }
    const decisionSentence = sentence.replace(/^(?:instead|rather)\b[,\s-]*/i, "");
    const match = DECISION_PATTERNS.map((pattern) => decisionSentence.match(pattern)).find(Boolean);
    if (!match) {
      continue;
    }
    const choice = normalizeText(match[1]).replace(/[;,]+$/, "").replace(/\s+(?:instead|rather)$/i, "").trim();
    const rationale = normalizeText(match[2] ?? "");
    if (!choice || choice.length < 3) {
      continue;
    }
    const reversal = /^(?:instead|rather)\b|\b(?:changed|switched|moved)\s+to\b|\b(?:no longer|reconsidered)\b|\s+(?:instead|rather)[.!?]*$/i.test(sentence);
    const scope = scopeForExtractedDirective(sentence, repository);
    const { scopeMetadata, ...scopeFields } = scope;
    memories.push({
      type: "decision",
      content: `Decision: ${choice}${rationale ? ` because ${rationale}` : ""}`,
      ...scopeFields,
      sourceSessionId: sessionId,
      sourceTurnIndex: turn.turn_index,
      confidence: 0.82,
      tags: ["decision", sourceRole, ...(reversal ? ["reversal"] : [])],
      metadata: {
        ...scopeMetadata,
        source: "rule_extractor",
        sourceRole,
        confidenceBasis: "explicit_completed_decision",
        verificationStatus: sourceRole === "assistant" ? "unverified_assistant_claim" : "conversation_record",
        ...(reversal ? { decisionStatus: "reversal" } : {}),
      },
    });
  }
  return memories;
}

const EVIDENCE_SOURCE_KINDS = Object.freeze({
  user_preference: "preference",
  rejected_approach: "rejection",
  decision: "decision",
  assistant_identity: "identity",
  user_identity: "identity",
  interaction_style: "style",
  assistant_goal: "goal",
  recurring_mistake: "rejection",
  open_loop: "open_loop",
  blocker: "blocker",
  commitment: "commitment",
});

function attachExtractionEvidence(memory, {
  sessionId,
  turn = null,
  fallbackRecordId,
  evidenceIndex,
}) {
  const content = normalizeText(memory.content);
  const contentHash = hashText(content);
  const sourceRecordId = turn?.source_record_id
    ?? turn?.turn_index
    ?? memory.sourceRecordId
    ?? fallbackRecordId
    ?? `memory:${evidenceIndex}`;
  const sourceKind = EVIDENCE_SOURCE_KINDS[memory.type] ?? memory.type ?? "semantic";
  const propositionHash = hashText(normalizeEvidenceText(content));
  const sourceRole = memory.metadata?.sourceRole
    ?? (turn?.assistant_response && !turn?.user_message ? "assistant" : "user");
  const sourceText = sourceRole === "assistant" ? turn?.assistant_response : turn?.user_message;
  const sourceRevision = turn
    ? hashText(JSON.stringify({
      role: sourceRole,
      text: normalizeText(sourceText),
    }))
    : contentHash;
  const revision = turn?.source_revision ?? memory.sourceRevision ?? sourceRevision;
  const key = `session:${sessionId}:record:${sourceRecordId}:type:${memory.type}:proposition:${propositionHash}`;
  return {
    ...memory,
    metadata: {
      ...memory.metadata,
      sourceAttribution: {
        sessionId,
        sourceRecordId: String(sourceRecordId),
        sourceRole,
      },
    },
    evidence: {
      key,
      sourceRecordId: String(sourceRecordId),
      sourceKind,
      revision: String(revision),
      contentHash,
    },
  };
}

export function attachEvidenceToSemanticMemories(memories, { sessionId, turns }) {
  const turnsByIndex = new Map(turns.map((turn) => [turn.turn_index, turn]));
  return memories.map((memory, index) => attachExtractionEvidence(memory, {
    sessionId,
    turn: turnsByIndex.get(memory.sourceTurnIndex) ?? null,
    fallbackRecordId: `${memory.type}:${hashText(normalizeEvidenceText(memory.content))}`,
    evidenceIndex: index,
  }));
}

const REVERSAL_STOPWORDS = new Set([
  "about", "app", "application", "because", "changed", "chose", "code", "concurrent", "database",
  "decided", "decision", "deployment", "embedded", "feature", "for", "implementation", "instead",
  "moved", "need", "needs", "on", "portable", "rather", "reconsidered", "selected", "service",
  "settled", "simple", "switched", "system", "target", "test", "testing", "tests", "the", "this",
  "use", "used", "using", "with", "will", "would", "writers",
]);

function decisionTopicTokens(content) {
  const normalized = normalizeText(content).toLowerCase();
  const topic = normalized.match(/\b(?:for|about|regarding|on)\s+(.+?)(?:\s+because\b|$)/)?.[1] ?? "";
  return new Set(topic
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !REVERSAL_STOPWORDS.has(token)));
}

function decisionsShareTopic(left, right) {
  const leftTokens = decisionTopicTokens(left.content);
  const rightTokens = decisionTopicTokens(right.content);
  return [...leftTokens].some((token) => rightTokens.has(token));
}

function collectRetiredEvidenceKeys(memories) {
  const decisions = memories
    .filter((memory) => memory.type === "decision" && memory.evidence?.key)
    .sort((left, right) => (left.sourceTurnIndex ?? 0) - (right.sourceTurnIndex ?? 0));
  const retired = [];
  for (let index = 0; index < decisions.length; index += 1) {
    const current = decisions[index];
    if (current.metadata?.decisionStatus !== "reversal") {
      continue;
    }
    for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
      const prior = decisions[priorIndex];
      if (decisionsShareTopic(prior, current)) {
        retired.push(prior.evidence.key);
        break;
      }
    }
  }
  return [...new Set(retired)];
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
  if (/\b(added|updated|extended|refined|implemented|captured|validated|scope|override|audit|backfill|restore|rollback|snapshot|prompt|identity|cross-repo|schema|trace|replay|deferred|memory|lore)\b/i.test(text)) {
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

function parseOutlineLine(rawLine, headings, itemCount) {
  if (!rawLine.trim()) {
    return null;
  }
  const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
  const level = Math.floor(indent / 2);
  const text = normalizeText(stripListMarkers(rawLine));
  if (!text) {
    return null;
  }
  while (headings.length > 0 && headings.at(-1).level >= level) {
    headings.pop();
  }
  if (/:\s*$/.test(text)) {
    headings.push({ level, text: text.replace(/:\s*$/, "") });
    return null;
  }
  const contextual = headings.length > 0
    ? `${headings.map((entry) => entry.text).join(": ")}: ${text}`
    : text;
  return { text: contextual, score: scoreStructuredLine(contextual), order: itemCount };
}

function rankOutlineItems(items, limit) {
  const seen = new Set();
  const results = [];
  const sorted = items.sort((left, right) => (
    right.score !== left.score ? right.score - left.score : left.order - right.order
  ));
  for (const item of sorted) {
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

function extractOutlineItems(value, { limit = 12 } = {}) {
  const items = [];
  const headings = [];
  for (const rawLine of String(value || "").split("\n")) {
    const item = parseOutlineLine(rawLine, headings, items.length);
    if (item) {
      items.push(item);
    }
  }
  return rankOutlineItems(items, limit);
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

function buildEpisodeSummaryFallback(repository, session, sessionId, details) {
  const location = repository || session.cwd || "local workspace";
  const branch = session.branch ? ` on ${session.branch}` : "";
  if (details.length > 0) {
    return truncateText(`Worked in ${location}${branch} — ${details.join(" | ")}`);
  }
  return `Worked in ${location}${branch || ""} (${sessionId})`;
}

function buildEpisodeSummarySeed({
  latestCheckpoint,
  session,
  turns,
  config,
}) {
  const candidates = [
    meaningfulSummary(latestCheckpoint?.title),
    meaningfulSummary(session.summary),
    meaningfulSummary(normalizeTurnText(turns[0]?.user_message, config)),
    meaningfulSummary(latestCheckpoint?.overview),
    meaningfulSummary(latestCheckpoint?.work_done),
    meaningfulSummary(normalizeTurnText(turns.at(-1)?.assistant_response, config)),
  ];
  return candidates.find(Boolean);
}

function buildEpisodeSummaryDetails({ decisions, actions, openItems, files, refs }) {
  const highlights = uniqueStrings([
    ...decisions.slice(0, 2),
    ...actions.slice(0, 2),
    ...openItems.slice(0, 1),
  ], 2);
  const summarizedPaths = summarizePaths(files);
  const summarizedRefs = summarizeRefs(refs);
  return [
    ...highlights,
    summarizedPaths.length > 0 ? `files: ${summarizedPaths.join(", ")}` : "",
    summarizedRefs.length > 0 ? `refs: ${summarizedRefs.join(", ")}` : "",
  ].filter(Boolean);
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
  const seed = buildEpisodeSummarySeed({ latestCheckpoint, session, turns, config });
  const details = buildEpisodeSummaryDetails({ decisions, actions, openItems, files, refs });

  if (seed) {
    return truncateText(
      `${seed}${details.length > 0 ? ` — ${details.join(" | ")}` : ""}`,
    );
  }

  return buildEpisodeSummaryFallback(repository, session, sessionId, details);
}

function extractSemanticMemoriesFromTurns(turns, repository, sessionId, config = null) {
  const memories = [];
  // Directive and decision evidence is source-addressed, so an older turn is
  // still useful on a later bounded ingestion pass. Keep the per-record work
  // sentence-level and let the caller bound how many source records it feeds.
  const recentTurns = turns;

  for (const turn of recentTurns) {
    const userMessage = normalizeTurnText(turn.user_message, config);
    const assistantResponse = normalizeTurnText(turn.assistant_response, config);
    if (userMessage) {
      const interactionStyleMemory = extractInteractionStyleMemory({
        message: userMessage,
        repository,
        sessionId,
        turnIndex: turn.turn_index,
      });
      if (interactionStyleMemory) {
        memories.push(interactionStyleMemory);
      }
      if (!interactionStyleMemory) {
        memories.push(...extractDirectiveMemoriesFromTurn({
          turn,
          text: userMessage,
          repository,
          sessionId,
          sourceRole: "user",
        }));
      }
      memories.push(...extractDecisionMemoryFromTurn({
        turn,
        text: userMessage,
        repository,
        sessionId,
        sourceRole: "user",
      }));
    }
    if (assistantResponse) {
      memories.push(...extractDecisionMemoryFromTurn({
        turn,
        text: assistantResponse,
        repository,
        sessionId,
        sourceRole: "assistant",
      }));
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

function detectInteractionStyleSignals(message) {
  return {
    requestPattern: firstMatchingPattern(message, INTERACTION_STYLE_REQUEST_PATTERNS),
    hasColleagueSignal: Boolean(firstMatchingPattern(message, INTERACTION_STYLE_COLLEAGUE_PATTERNS)),
    hasFriendlySignal: Boolean(firstMatchingPattern(message, INTERACTION_STYLE_FRIENDLY_PATTERNS)),
    hasCollaborativeSignal: Boolean(firstMatchingPattern(message, INTERACTION_STYLE_COLLABORATIVE_PATTERNS)),
    hasHumorPositiveSignal: Boolean(firstMatchingPattern(message, INTERACTION_STYLE_HUMOR_POSITIVE_PATTERNS)),
    hasHumorNegativeSignal: Boolean(firstMatchingPattern(message, INTERACTION_STYLE_HUMOR_NEGATIVE_PATTERNS)),
    hasHumorFrequentSignal: Boolean(firstMatchingPattern(message, INTERACTION_STYLE_HUMOR_FREQUENT_PATTERNS)),
    useNameNaturally: Boolean(firstMatchingPattern(message, INTERACTION_STYLE_NAME_NATURAL_PATTERNS)),
  };
}

function hasInteractionStyleSignal(signals) {
  return signals.hasColleagueSignal
    || signals.hasFriendlySignal
    || signals.hasCollaborativeSignal
    || signals.hasHumorPositiveSignal
    || signals.hasHumorNegativeSignal
    || signals.useNameNaturally;
}

function resolveVoice(signals) {
  if (signals.hasColleagueSignal) return "colleague";
  if (signals.hasCollaborativeSignal) return "collaborative";
  return "friendly";
}

function resolveHumorFrequency(signals) {
  if (signals.hasHumorNegativeSignal || !signals.hasHumorPositiveSignal) return "never";
  return signals.hasHumorFrequentSignal ? "frequent" : "occasional";
}

function buildInteractionStyleProfile(signals) {
  return {
    voice: resolveVoice(signals),
    warmth: signals.hasFriendlySignal ? "warm" : "balanced",
    humor: signals.hasHumorNegativeSignal || !signals.hasHumorPositiveSignal ? "none" : "light",
    humorFrequency: resolveHumorFrequency(signals),
    collaborative: signals.hasCollaborativeSignal || signals.hasColleagueSignal,
    useNameNaturally: signals.useNameNaturally,
  };
}

function extractInteractionStyleMemory({ message, repository, sessionId, turnIndex }) {
  void repository;
  const signals = detectInteractionStyleSignals(message);
  if (!signals.requestPattern) {
    return null;
  }
  if (!hasInteractionStyleSignal(signals)) {
    return null;
  }

  const profile = buildInteractionStyleProfile(signals);

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
      requestPattern: signals.requestPattern.toString(),
    },
  };
}

function extractAssistantIdentityMemories(turns, sessionId) {
  const memories = [];
  const recentTurns = turns.slice(-12);
  for (const turn of recentTurns) {
    const message = normalizeTurnText(turn.user_message);
    const assistantName = detectAssistantIdentityDeclaration(message);
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

function resolveSessionRepository({ repository, session, workspace }) {
  return repository
    ?? session.repository
    ?? workspace.workspace?.repository
    ?? null;
}

function buildSessionSemanticMemories({
  turns,
  effectiveRepository,
  sessionId,
  actions,
  decisions,
  openItems,
  config,
}) {
  const explicitMemories = extractSemanticMemoriesFromTurns(turns, effectiveRepository, sessionId, config);
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

  return {
    learnings: explicitMemories.map((item) => item.content),
    semanticMemories: [
      ...extractAssistantIdentityMemories(turns, sessionId),
      ...extractUserIdentityMemories(turns, effectiveRepository, sessionId),
      ...assistantGoalMemories,
      ...(implicitAssistantGoal ? [implicitAssistantGoal] : []),
      ...recurringMistakeMemories,
      ...(implicitRecurringMistake ? [implicitRecurringMistake] : []),
      ...explicitMemories,
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


export function extractSessionMemories({ sessionId, repository, sessionArtifacts, workspace, config = null }) {
  const { session, checkpoints, files, refs, turns } = sessionArtifacts;
  const latestCheckpoint = checkpoints[0] ?? null;
  const effectiveRepository = resolveSessionRepository({ repository, session, workspace });
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
  const { learnings, semanticMemories: unannotatedSemanticMemories } = buildSessionSemanticMemories({
    turns,
    effectiveRepository,
    sessionId,
    actions,
    decisions,
    openItems,
    config,
  });
  const semanticMemories = attachEvidenceToSemanticMemories(unannotatedSemanticMemories, {
    sessionId,
    turns,
  });
  const retiredEvidenceKeys = collectRetiredEvidenceKeys(semanticMemories);
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
    semanticMemories,
    retiredEvidenceKeys,
  };
}
