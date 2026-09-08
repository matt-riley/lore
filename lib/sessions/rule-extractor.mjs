import {
  detectAssistantIdentityDeclaration,
  detectUserIdentityName,
  MEMORY_SCOPE,
} from "../memory/memory-scope.mjs";
import { createHash } from "node:crypto";
import { normalizeText } from "../utils/text-normalizer.mjs";
import { readRetentionSanitizationEnabled } from "../rollout/rollout-flags.mjs";
import { collectRetiredDirectiveEvidenceKeys } from "./directive-corrections.mjs";
import { collectRetiredDecisionEvidenceKeys } from "./decision-subject.mjs";
import { stripInjectedContext } from "../memory/retention-sanitizer.mjs";
import {
  directiveBody,
  isHypotheticalDirectiveSentence,
  isNonDirectiveSentence,
  isOneOffDirectiveRequest,
  splitDirectiveClauses,
  splitSentences,
  standingDirectiveType,
} from "./extraction-grammar.mjs";

function normalizeTurnText(value, config = null) {
  const text = readRetentionSanitizationEnabled(config)
    ? stripInjectedContext(value)
    : String(value || "");
  return normalizeText(text);
}

function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function sourceRevisionForTurn(turn, sourceRole) {
  return turn.source_revision ?? hashText(JSON.stringify({
    role: sourceRole,
    text: normalizeText(sourceRole === "assistant" ? turn.assistant_response : turn.user_message),
  }));
}

function assistantSourceTurns(turn) {
  if (!Array.isArray(turn.assistant_source_records)) {
    return [turn];
  }
  // The array is authoritative, including an empty array after a source was
  // removed. The combined response exists only for older producer contracts.
  return turn.assistant_source_records
    .filter((record) => record?.source_record_id != null && typeof record.text === "string")
    .map((record) => ({
      ...turn,
      assistant_response: record.text,
      source_record_id: record.source_record_id,
      source_revision: record.source_revision,
    }));
}

function normalizeEvidenceText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/["'’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  /^(?:please\s+)?remember\s+.+$/i,
  /^split\s+(?:changes|commits)\b.+$/i,
  /^(?:please\s+)?(?:use|keep|include|show|run|write|ask|check|preserve|make)\s+.+\s+(?:for|when|in)\s+(?:this|the)\s+(?:repo|repository|project)\b.*$/i,
  /^please\s+(?:keep|make|write|format)\s+.+$/i,
];

const EXPLICIT_REJECTION_PATTERNS = [
  /^(?:please\s+)?(?:do not|don't|never)\s+(?:ever\s+)?(?!(?:forget)\b)(?:use|store|include|show|run|write|ask|check|preserve|make|put|retain|drop|remove|retry|commit|push|delete|merge|overwrite|ignore|assume|send|expose|log|add|change|modify|rely|return|start)\b.+$/i,
  /^(?:please\s+)?avoid\s+.+$/i,
  /^(?:please\s+)?stop\s+.+$/i,
  /^(?:i|we)\s+(?:do not|don't|never)\s+(?:want|like|use|need|store|include|see)\s+.+$/i,
];

const EXPLICIT_GLOBAL_SCOPE_PATTERN = /\b(?:for\s+all\s+work|(?:in|for)\s+(?:any|every)\s+(?:project|repository|repo)|reviewing\s+any\s+(?:project|repository|repo)|globally|across\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?(?:projects|repositories|repos)|for\s+(?:every|all)\s+(?:my\s+)?(?:project|repository|repo)|regardless\s+of\s+(?:the\s+)?repo(?:sitory)?|in\s+all\s+(?:of\s+)?(?:my\s+)?(?:projects|repositories|repos))\b/i;

function hasExplicitDirective(text, patterns) {
  const body = directiveBody(text);
  const correctionLead = /^actually\s*,?\s*(?:that(?:'s| is)\s+wrong\s*:\s*)/i.test(text);
  if (patterns === EXPLICIT_REJECTION_PATTERNS && /^(?:please\s+)?(?:do not|don't)\s+forget\b/i.test(body)) {
    return false;
  }
  const standing = standingDirectiveType(text);
  return !isNonDirectiveSentence(text, { allowConditions: true })
    && !isHypotheticalDirectiveSentence(text)
    && !isOneOffDirectiveRequest(text)
    && ((patterns === EXPLICIT_REJECTION_PATTERNS && standing === "rejected_approach")
      || patterns.some((pattern) => pattern.test(body))
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

function buildDirectiveMemory({ sentence, scopeText = sentence, type, repository, sessionId, turn, sourceRole }) {
  const scope = scopeForExtractedDirective(scopeText, repository);
  const rejection = type === "rejected_approach";
  const standing = type === "directive";
  const { scopeMetadata, ...scopeFields } = scope;
  return {
    type,
    content: sentence,
    ...scopeFields,
    sourceSessionId: sessionId,
    sourceTurnIndex: turn.turn_index,
    confidence: rejection ? 0.76 : 0.78,
    tags: rejection
      ? ["rejected", sourceRole]
      : standing
        ? ["directive", "policy", sourceRole]
        : ["preference", sourceRole],
    metadata: {
      ...scopeMetadata,
      source: "rule_extractor",
      sourceRole,
      confidenceBasis: rejection
        ? "explicit_rejection_sentence"
        : standing
          ? "standing_policy_sentence"
          : "explicit_preference_sentence",
    },
  };
}

export function extractDirectiveMemoriesFromTurn({ turn, text, repository, sessionId, sourceRole }) {
  const memories = [];
  const turnMessage = turn?.user_message ? normalizeTurnText(turn.user_message) : "";
  const isTurnOneOff = Boolean(turnMessage && isOneOffDirectiveRequest(turnMessage));
  for (const rawSentence of splitSentences(text, { splitSemicolons: false })) {
    if (isNonDirectiveSentence(rawSentence, { allowConditions: true })
      || isHypotheticalDirectiveSentence(rawSentence)
      || isOneOffDirectiveRequest(rawSentence)
      || (isTurnOneOff
        && !/^(?:as\s+(?:a\s+)?policy|in\s+(?:the\s+)?future|going\s+forward|from\s+now\s+on)\b/i.test(rawSentence)
        && !/^(?:please\s+)?(?:(?:i|we)\s+)?(?:always|never|prefer)\b/i.test(rawSentence)
        && standingDirectiveType(rawSentence) !== "directive")) {
      continue;
    }
    const clauses = splitDirectiveClauses(rawSentence);
    // A diagnostic observation followed by a semicolon and an action is still
    // an incident request; the first clause must establish a standing rule.
    if (rawSentence.includes(";") && !hasExplicitDirective(clauses[0], EXPLICIT_PREFERENCE_PATTERNS)
      && !hasExplicitDirective(clauses[0], EXPLICIT_REJECTION_PATTERNS)
      && standingDirectiveType(clauses[0]) !== "directive") continue;
    for (const sentence of clauses) {
      const carriesSharedCondition = clauses.length > 1 && /\b(?:if|when|whenever|unless)\b/i.test(rawSentence);
      const contentSentence = carriesSharedCondition || (/^please\s/i.test(sentence) && /\bso\b/i.test(rawSentence))
        ? rawSentence
        : sentence;
      if (hasExplicitDirective(sentence, EXPLICIT_PREFERENCE_PATTERNS)) {
        memories.push(buildDirectiveMemory({
          sentence: contentSentence,
          scopeText: rawSentence,
          type: "user_preference",
          repository,
          sessionId,
          turn,
          sourceRole,
        }));
      } else if (standingDirectiveType(sentence) === "directive") {
        memories.push(buildDirectiveMemory({
          sentence: contentSentence,
          scopeText: rawSentence,
          type: "directive",
          repository,
          sessionId,
          turn,
          sourceRole,
        }));
      }
      if (hasExplicitDirective(sentence, EXPLICIT_REJECTION_PATTERNS)) {
        memories.push(buildDirectiveMemory({
          sentence: contentSentence,
          scopeText: rawSentence,
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
  /^(?:we|i)\s+(?:(?:initially|ultimately|finally)\s+)?(?:chose|selected|settled\s+on)\s+(.+?)(?:\s+because\s+(.+))?$/i,
  /^(?:we|i)\s+(?:changed|switched|moved)\s+to\s+(.+?)(?:\s+because\s+(.+))?$/i,
  /^(?:after|following)\s+[^,]+,\s*(?:we|i)\s+(?:(?:initially|ultimately|finally)\s+)?(?:chose|selected|settled\s+on)\s+(.+?)(?:\s+because\s+(.+))?$/i,
  /^the\s+decision\s+changed\b.*?:\s*(?:use|choose)\s+(.+?)(?:\s+because\s+(.+))?$/i,
  /^the\s+(?:[a-z][a-z0-9-]*\s+){0,4}decision\s+is\s+(?:to\s+)?(.+?)(?:\s+because\s+(.+))?$/i,
];

function isNonCompletedDecisionSentence(text) {
  return /\b(?:asked|whether|unclear|not\s+decided|still\s+open|hypothetical|scenario|example|i\s+think|i\s+believe|not\s+verified|have\s+not\s+verified|perhaps|maybe|possibly|probably|did\s+not|didn't)\b/i.test(text);
}

export function extractDecisionMemoryFromTurn({ turn, text, repository, sessionId, sourceRole }) {
  const memories = [];
  for (const sentence of splitSentences(text)) {
    if (isNonDirectiveSentence(sentence) || isNonCompletedDecisionSentence(sentence)) {
      continue;
    }
    const decisionSentence = sentence.replace(/^(?:instead|rather)\b[,\s-]*/i, "");
    const match = DECISION_PATTERNS.map((pattern) => decisionSentence.match(pattern)).find(Boolean);
    if (!match) {
      continue;
    }
    const choice = normalizeText(match[1]).replace(/[;,]+$/, "").replace(/\s+(?:instead|rather)$/i, "").trim();
    const rationale = normalizeText(match[2] ?? "");
    const context = decisionSentence.match(/^((?:after|following)\s+[^,]+),/i)?.[1] ?? "";
    if (!choice || choice.length < 3 || /^(?:recorded|documented|pending|open|undecided|unchanged|being)\b/i.test(choice)) {
      continue;
    }
    const reversal = /^(?:instead|rather)\b|\bdecision\s+changed\b|\b(?:changed|switched|moved)\s+to\b|\b(?:no longer|reconsidered)\b|\s+(?:instead|rather)[.!?]*$/i.test(sentence);
    const contextualReversal = /\bdecision\s+changed\b|^(?:after|following|once)\b.*\b(?:we|i)\s+(?:chose|selected|settled\s+on)\b/i.test(sentence);
    const scope = scopeForExtractedDirective(sentence, repository);
    const { scopeMetadata, ...scopeFields } = scope;
    memories.push({
      type: "decision",
      content: `Decision: ${choice}${rationale ? ` because ${rationale}` : ""}${context ? ` (${context})` : ""}`,
      ...scopeFields,
      sourceSessionId: sessionId,
      sourceTurnIndex: turn.turn_index,
      sourceRecordId: turn.source_record_id ?? turn.turn_index,
      sourceRevision: sourceRevisionForTurn(turn, sourceRole),
      confidence: 0.82,
      tags: ["decision", sourceRole, ...(reversal ? ["reversal"] : [])],
      metadata: {
        ...scopeMetadata,
        source: "rule_extractor",
        sourceRole,
        confidenceBasis: "explicit_completed_decision",
        decisionChoice: choice,
        decisionRationale: rationale,
        ...(context ? { decisionContext: context } : {}),
        verificationStatus: sourceRole === "assistant" ? "unverified_assistant_claim" : "conversation_record",
        ...(reversal ? { decisionStatus: "reversal" } : {}),
        ...(contextualReversal ? { contextualReversal: true } : {}),
      },
    });
  }
  return memories;
}

const EVIDENCE_SOURCE_KINDS = Object.freeze({
  user_preference: "preference",
  directive: "directive",
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
  learned_rule: "learning",
});

function attachExtractionEvidence(memory, {
  sessionId,
  turn = null,
  fallbackRecordId,
  evidenceIndex,
}) {
  const content = normalizeText(memory.content);
  const contentHash = hashText(content);
  const sourceRecordId = memory.sourceRecordId
    ?? turn?.source_record_id
    ?? turn?.turn_index
    ?? fallbackRecordId
    ?? `memory:${evidenceIndex}`;
  const sourceKind = EVIDENCE_SOURCE_KINDS[memory.type] ?? memory.type ?? "semantic";
  const propositionHash = hashText(normalizeEvidenceText(content));
  const sourceRole = memory.metadata?.sourceRole
    ?? (turn?.assistant_response && !turn?.user_message ? "assistant" : "user");
  const sourceRevision = turn ? sourceRevisionForTurn(turn, sourceRole) : contentHash;
  const revision = memory.sourceRevision ?? sourceRevision;
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
  outcome = null,
}) {
  const seed = outcome ?? buildEpisodeSummarySeed({ latestCheckpoint, session, turns, config });
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
    if (userMessage) {
      for (const sentence of splitSentences(userMessage, { splitSemicolons: false })) {
        const interactionStyleMemory = extractInteractionStyleMemory({
          message: sentence,
          repository,
          sessionId,
          turnIndex: turn.turn_index,
        });
        if (interactionStyleMemory) memories.push(interactionStyleMemory);
        else memories.push(...extractDirectiveMemoriesFromTurn({
          turn,
          text: sentence,
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
    for (const assistantTurn of assistantSourceTurns(turn)) {
      const assistantResponse = normalizeTurnText(assistantTurn.assistant_response, config);
      if (assistantResponse) {
        memories.push(...extractDecisionMemoryFromTurn({
          turn: assistantTurn,
          text: assistantResponse,
          repository,
          sessionId,
          sourceRole: "assistant",
        }));
      }
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

// Genuine persona declarations can be global, but an explicit repository
// qualifier takes precedence over this type's default.
function personaScope(message, repository) {
  const repoSpecific = /\b(?:for|in)\s+(?:this|the current)(?:\s+[a-z][a-z0-9_-]*){0,2}\s+(?:repo(?:sitory)?|project|app)\b/i.test(message);
  return repoSpecific
    ? { scope: MEMORY_SCOPE.REPO, repository }
    : { scope: MEMORY_SCOPE.GLOBAL, repository: null };
}

function extractInteractionStyleMemory({ message, repository, sessionId, turnIndex }) {
  if (message.includes(";") || isOneOffDirectiveRequest(message)) return null;
  const body = directiveBody(message);
  const requestBody = body.replace(/^(?:can|could|would) you\s+(?=(?:talk|speak|respond|reply|sound|be|keep|write|communicate|use|add|include)\b)/i, "please ");
  const direct = requestBody === body ? body : requestBody.replace(/\?$/, ".");
  if (/^(?:i(?:'d| would)? like|i want)\s+to\s+(?:know|understand|learn|explain|discuss|document|describe)\b/i.test(direct)) return null;
  if (isNonDirectiveSentence(direct) || isHypotheticalDirectiveSentence(message)
    || !/^(?:please\s+)?(?:talk|speak|respond|reply|sound|be|keep|write|communicate|use|add|include|i(?:'d| would)? like|i prefer|i want|it helps when|feel free to|let'?s|we should)\b/i.test(direct)) return null;
  const signals = detectInteractionStyleSignals(direct);
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
    ...personaScope(message, repository),
    sourceSessionId: sessionId,
    sourceTurnIndex: turnIndex,
    confidence: 0.78,
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
      sourceRole: "user",
      confidenceBasis: "explicit_style_sentence",
      profile,
      patternType: "direct_or_soft",
      requestPattern: signals.requestPattern.toString(),
    },
  };
}

function extractAssistantIdentityMemories(turns, repository, sessionId) {
  const memories = [];
  for (const turn of turns) {
    for (const message of splitSentences(normalizeTurnText(turn.user_message))) {
      const assistantName = detectAssistantIdentityDeclaration(directiveBody(message));
      if (!assistantName || isNonDirectiveSentence(message) || isHypotheticalDirectiveSentence(message) || isOneOffDirectiveRequest(message)) continue;
      memories.push({
        type: "assistant_identity",
        content: `The user calls the assistant ${assistantName}.`,
        ...personaScope(message, repository),
        sourceSessionId: sessionId,
        sourceTurnIndex: turn.turn_index,
        confidence: 0.85,
        tags: ["assistant-identity", "user", assistantName.toLowerCase()],
        metadata: {
          source: "rule_extractor",
          sourceRole: "user",
          confidenceBasis: "explicit_naming_sentence",
          assistantName,
        },
      });
    }
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

function cleanMistakeText(value) {
  return normalizeText(value)
    .replace(/^[\s.:,;'"“”‘’`-]+/, "")
    .replace(/[\s.:,;'"“”‘’`-]+$/, "")
    .trim();
}

function extractRecurringMistakeMemories(turns, repository, sessionId, config = null) {
  const memories = [];
  const seen = new Set();
  for (const turn of turns.slice(-20)) {
    for (const sentence of splitSentences(normalizeTurnText(turn.user_message, config))) {
      if (isNonDirectiveSentence(sentence) || isHypotheticalDirectiveSentence(sentence)) continue;
      const body = directiveBody(sentence);
      // Anchor feedback to the user addressing the assistant. Reported speech,
      // incidental occurrences of "again", and praise are not corrections.
      const match = body.match(/^(?:you keep|you are repeating|you(?:'re| are) making the same mistake)\b[:\s-]*(.+)$/i)
        ?? (/^you always\b/i.test(body) && /\b(?:ignor(?:e|ing)|forget(?:ting)?|fail(?:ing)?|wrong|stale|incorrect|broken|mistakes?)\b/i.test(body)
          ? body.match(/^you always\b[:\s-]*(.+)$/i) : null);
      const rawMistake = match?.[1] ?? "";
      const mistake = cleanMistakeText(rawMistake);
      if (!mistake || mistake.length < 12) continue;
      if (mistake.includes("?")) continue;
      const mistakeWords = mistake.toLowerCase().split(/\s+/).filter(Boolean);
      if (new Set(mistakeWords).size < 3) continue;
      if (/^(?:sad\s+times|bad\s+times|oh\s+well|never\s+mind|ugh|oops|yikes|haha|lol|sigh)\b/i.test(mistake)) continue;
      if (!/\b(?:[a-z]+ing|[a-z]+ed|break|fail|forget|ignore|miss|drop|delete|change|modify|revert|use|create|add|run|stop|make|edit|write|commit|push|overwrite|assume|leave|skip|lose|cause|rely|repeat|introduce|do|did|does)\b/i.test(mistake)) {
        continue;
      }
      const key = mistake.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const { scopeMetadata, ...scope } = scopeForExtractedDirective(sentence, repository);
      memories.push({
        type: "recurring_mistake",
        content: `Recurring mistake to avoid: ${mistake}`,
        scope: MEMORY_SCOPE.REPO,
        repository,
        ...scope,
        sourceSessionId: sessionId,
        sourceTurnIndex: turn.turn_index,
        confidence: 0.76,
        tags: ["recurring-mistake", "feedback", "user"],
        metadata: {
          ...scopeMetadata,
          source: "rule_extractor",
          sourceRole: "user",
          confidenceBasis: "direct_recurring_feedback",
          mistake,
        },
      });
    }
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
    if (!message || message.length > 280 || isNonDirectiveSentence(message) || isHypotheticalDirectiveSentence(message)) {
      continue;
    }
    if (!firstMatchingPattern(message, IMPLICIT_CORRECTION_PATTERNS.slice(0, -2))) {
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

function inferRecurringMistakeFromCorrections(turns, repository, sessionId, config = null) {
  const signals = collectImplicitCorrectionSignals(turns, config);
  if (signals.length < 2) {
    return null;
  }
  const examples = uniqueStrings(signals.map((signal) => signal.text), 3);
  const mistake = "missing or overriding explicit user corrections before continuing implementation";
  return {
    type: "recurring_mistake",
    content: `Recurring mistake to avoid: ${mistake}.`,
    repository,
    scope: MEMORY_SCOPE.REPO,
    sourceSessionId: sessionId,
    sourceTurnIndex: signals.at(-1)?.turnIndex ?? null,
    confidence: 0.7,
    tags: ["recurring-mistake", "feedback", "implicit-session", "correction-pattern"],
    metadata: {
      source: "implicit_session_inference",
      sourceRole: "user",
      confidenceBasis: "repeated_direct_user_corrections",
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
      {
        turnIndex: turn.turn_index,
        sourceRole: "user",
        sourceRecordId: turn.source_record_id ?? null,
        sourceRevision: turn.source_revision ?? null,
        text: normalizeTurnText(turn.user_message, config),
      },
      ...assistantSourceTurns(turn).map((assistantTurn) => ({
        turnIndex: turn.turn_index,
        sourceRole: "assistant",
        sourceRecordId: assistantTurn.source_record_id ?? null,
        sourceRevision: sourceRevisionForTurn(assistantTurn, "assistant"),
        text: normalizeTurnText(assistantTurn.assistant_response, config),
      })),
    ]),
    ...actions.map((text) => ({ turnIndex: null, sourceRole: null, text: normalizeText(text) })),
    ...decisions.map((text) => ({ turnIndex: null, sourceRole: null, text: normalizeText(text) })),
    ...openItems.map((text) => ({ turnIndex: null, sourceRole: null, text: normalizeText(text) })),
  ];

  const signals = [];
  for (const source of sources) {
    if (!source.text || source.text.length > 280) {
      continue;
    }
    if (source.sourceRole === "user" && firstMatchingPattern(source.text, IMPLICIT_CORRECTION_PATTERNS)) {
      continue;
    }
    if (source.sourceRole === "assistant" && /\b(?:corrected|correction|understood)\b/i.test(source.text)) {
      continue;
    }
    const observation = splitSentences(source.text).filter((sentence) =>
      !isNonDirectiveSentence(sentence)
      && !isNonCompletedDecisionSentence(sentence)
      && !standingDirectiveType(sentence)
      && !/^(?:please|(?:i|we)\s+will)\b/i.test(sentence)
      && firstMatchingPattern(sentence, FAILURE_SIGNAL_PATTERNS)
      && !firstMatchingPattern(sentence, FAILURE_RESOLUTION_PATTERNS),
    ).join(" ");
    if (!observation) {
      continue;
    }
    signals.push({
      turnIndex: source.turnIndex,
      sourceRole: source.sourceRole ?? null,
      sourceRecordId: source.sourceRecordId ?? null,
      sourceRevision: source.sourceRevision ?? null,
      text: truncateText(observation, 140),
    });
  }
  const uniqueSignals = [];
  const seen = new Set();
  for (const signal of signals) {
    if (seen.has(signal.text)) {
      continue;
    }
    seen.add(signal.text);
    uniqueSignals.push(signal);
    if (uniqueSignals.length >= 4) {
      break;
    }
  }
  return uniqueSignals;
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
  const distinctFailureTurns = new Set(
    signals
      .map((signal) => signal.turnIndex)
      .filter((turnIndex) => Number.isInteger(turnIndex)),
  );
  const hasRecurrenceMarker = signals.some((signal) => /\b(?:again|repeated|recurring|keeps?|every\s+time|still)\b/i.test(signal.text));
  const failureTopicStopwords = new Set([
    "again", "after", "before", "debugging", "endpoint", "failed", "failing", "failure", "include",
    "inspect", "logs", "please", "report", "reproduce", "reproduction", "request", "response", "result",
    "the", "timeout",
  ]);
  const topicSets = signals.map((signal) => new Set(
    signal.text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((token) => token.length >= 5 && !failureTopicStopwords.has(token)),
  ));
  const hasRepeatedTopic = topicSets.some((left, index) => topicSets
    .slice(index + 1)
    .some((right) => [...left].some((token) => right.has(token))));
  if (signals.length < 2 || distinctFailureTurns.size < 2 || (!hasRecurrenceMarker && !hasRepeatedTopic)) {
    return null;
  }
  const examples = signals.map((signal) => signal.text);
  const goal = classifyImplicitFailureGoal(examples);
  const selectedSignal = signals.at(-1) ?? {};
  return {
    type: "assistant_goal",
    content: `Current assistant goal: ${goal}`,
    repository,
    sourceSessionId: sessionId,
    sourceTurnIndex: selectedSignal.turnIndex ?? null,
    sourceRecordId: selectedSignal.sourceRecordId ?? null,
    sourceRevision: selectedSignal.sourceRevision ?? null,
    confidence: 0.82,
    tags: ["assistant-goal", "implicit-session", "failure-repair"],
    metadata: {
      source: "implicit_session_inference",
      signalType: "repeated_failure",
      goal,
      failureCount: signals.length,
      examples,
      ...(selectedSignal.sourceRole ? { sourceRole: selectedSignal.sourceRole } : {}),
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
  const recurringMistakeMemories = extractRecurringMistakeMemories(turns, effectiveRepository, sessionId, config);
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
    ? inferRecurringMistakeFromCorrections(turns, effectiveRepository, sessionId, config)
    : null;

  return {
    learnings: explicitMemories.map((item) => item.content),
    semanticMemories: [
      ...extractAssistantIdentityMemories(turns, effectiveRepository, sessionId),
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
  const retiredEvidenceKeys = [
    ...collectRetiredDecisionEvidenceKeys(semanticMemories),
    ...collectRetiredDirectiveEvidenceKeys(semanticMemories, turns),
  ];
  const retired = new Set(retiredEvidenceKeys);
  const activeContents = new Set(semanticMemories.filter((memory) => !retired.has(memory.evidence.key)).map((memory) => memory.content));
  const activeLearnings = learnings.filter((content) => activeContents.has(content));
  const outcomes = semanticMemories.filter((memory) => memory.type === "decision" && !retired.has(memory.evidence.key));
  const attributedOutcomes = uniqueStrings(outcomes.slice(-8).map((memory) =>
    `${memory.metadata?.sourceRole === "assistant" ? "Assistant reported" : "User stated"}: ${memory.content}`,
  ));
  const episodeDecisions = uniqueStrings([...attributedOutcomes, ...decisions]);
  const summary = buildEpisodeSummary({
    sessionId,
    repository: effectiveRepository,
    session,
    latestCheckpoint,
    turns,
    files,
    refs,
    actions,
    decisions: episodeDecisions,
    openItems,
    config,
    outcome: attributedOutcomes.at(-1) ?? null,
  });

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
      decisions: episodeDecisions,
      learnings: activeLearnings,
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
