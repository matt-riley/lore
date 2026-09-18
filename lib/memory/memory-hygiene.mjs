import crypto from "node:crypto";
import { execFile } from "node:child_process";

const COMPLETION_PATTERN =
  /\b(?:completed|done|fixed|merged|promoted|landed|shipped|resolved|closed|deployed|released|finished|passed|green)\b/i;
const COMPLETION_NEGATION_PATTERN = /\b(?:not|never|no longer|unmerged|unlanded|unshipped|isn['’]?t|wasn['’]?t|weren['’]?t|hasn['’]?t|haven['’]?t|hadn['’]?t|didn['’]?t|doesn['’]?t|don['’]?t|cannot|can['’]?t|won['’]?t|wouldn['’]?t|shouldn['’]?t)\b/i;
const COMPLETION_CONDITION_PATTERN = /\b(?:will|would|should|shall|may|might|could|can|to be|expected to|supposed to|plan(?:s|ned)? to|intend(?:s|ed)? to|once|if|when|unless|until|pending|awaiting)\b/i;
const COMPLETION_PARTIAL_PATTERN = /\b(?:partially|partly|half|incomplete|first part|part of)\b/i;
const QUOTED_TEXT_PATTERN = /"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’/g;
const PROMOTION_PATTERN =
  /\b(?:promote|merge|cherry-pick|land|integrate)\b/i;
const COMMIT_PATTERN = /\b[0-9a-f]{7,40}\b/gi;
const NUMBERED_REF_PATTERN = /(?:#|\/(?:pull|issues)\/)(\d+)\b/gi;
const STABILISATION_TYPES = new Set(["open_loop", "assistant_goal"]);

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTarget(value) {
  return normalizeText(value)
    .replace(/^[-*]\s+/, "")
    .replace(/^(?:current\s+assistant\s+goal|open\s+loop|stabilisation\s+goal)\s*:\s*/i, "")
    .replace(/^(?:completed|done|fixed|merged|promoted|landed|shipped|resolved|closed|deployed|released|finished)\s*:\s*/i, "")
    .replace(/[.!?]+$/, "")
    .trim()
    .toLowerCase();
}

function extractStableIdentifiers(value) {
  const text = normalizeText(value);
  const identifiers = new Set();
  for (const match of text.matchAll(COMMIT_PATTERN)) {
    identifiers.add(`commit:${match[0].toLowerCase()}`);
  }
  for (const match of text.matchAll(NUMBERED_REF_PATTERN)) {
    identifiers.add(`ref:${match[1]}`);
  }
  return identifiers;
}

function hasIdentifierOverlap(left, right) {
  const leftIdentifiers = extractStableIdentifiers(left);
  if (leftIdentifiers.size === 0) {
    return false;
  }
  const rightIdentifiers = extractStableIdentifiers(right);
  return [...leftIdentifiers].some((identifier) => rightIdentifiers.has(identifier));
}

function targetsMatch(memoryContent, evidenceText) {
  const target = normalizeTarget(memoryContent);
  const evidenceTarget = normalizeTarget(evidenceText);
  return target.length >= 12 && target === evidenceTarget;
}

function evidenceMatches(memoryContent, evidenceText, { requireExactTarget = false } = {}) {
  if (requireExactTarget) {
    return targetsMatch(memoryContent, evidenceText);
  }
  return targetsMatch(memoryContent, evidenceText)
    || hasIdentifierOverlap(memoryContent, evidenceText);
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isLaterEpisode(memory, episode) {
  const memoryTimestamp = parseTimestamp(memory.updated_at ?? memory.updatedAt);
  const episodeTimestamp = parseTimestamp(episode.updatedAt ?? episode.updated_at);
  return memoryTimestamp != null
    && episodeTimestamp != null
    && episodeTimestamp > memoryTimestamp;
}

function listEpisodeCompletionLines(episode) {
  return [
    episode.summary,
    ...(Array.isArray(episode.actions) ? episode.actions : []),
    ...(Array.isArray(episode.decisions) ? episode.decisions : []),
  ].map(normalizeText).filter(Boolean);
}

function findNegativeEvidence(memory, episodes) {
  for (const episode of episodes) {
    if (!isLaterEpisode(memory, episode)) {
      continue;
    }
    for (const openItem of Array.isArray(episode.openItems) ? episode.openItems : []) {
      if (evidenceMatches(memory.content, openItem)) {
        return {
          episode,
          evidenceText: normalizeText(openItem),
        };
      }
    }
  }
  return null;
}

function findCompletionEvidence(memory, episodes, requireExactTarget) {
  for (const episode of episodes) {
    if (!isLaterEpisode(memory, episode)) {
      continue;
    }
    for (const line of listEpisodeCompletionLines(episode)) {
      if (!hasAffirmativeCompletion(line)) {
        continue;
      }
      if (evidenceMatches(memory.content, line, { requireExactTarget })) {
        return {
          episode,
          evidenceText: line,
        };
      }
    }
  }
  return null;
}

// A completion keyword is only evidence when it claims affirmative completion
// of this target. Negation, future/conditional phrasing, quoted claims, and
// partial milestones must not retire open work, so reject anything but a
// plain statement that the work happened.
function hasAffirmativeCompletion(line) {
  const unquoted = String(line ?? "").replace(QUOTED_TEXT_PATTERN, " ");
  const match = COMPLETION_PATTERN.exec(unquoted);
  if (!match) {
    return false;
  }
  if (COMPLETION_NEGATION_PATTERN.test(unquoted) || COMPLETION_PARTIAL_PATTERN.test(unquoted)) {
    return false;
  }
  const prefix = unquoted.slice(0, match.index).slice(-48);
  return !COMPLETION_CONDITION_PATTERN.test(prefix);
}

function findPromotionCommit(content) {
  if (!PROMOTION_PATTERN.test(content)) {
    return null;
  }
  return [...normalizeText(content).matchAll(COMMIT_PATTERN)][0]?.[0]?.toLowerCase() ?? null;
}

import {
  FEATURE_PROMPT_VERSION,
  minSpecificity,
  persistMemoryFeatures,
  scoreMemoryFeatures,
  typesafeFeaturesEnabled,
} from "../inference/typesafe-features.mjs";

/** Stored specificity, or null when it is missing or from an older question. */
function storedSpecificity(memory) {
  const typesafe = memory?.metadata?.typesafe;
  if (!typesafe || Number(typesafe.promptVersion) !== FEATURE_PROMPT_VERSION) {
    return null;
  }
  const value = Number(typesafe.specificity);
  return Number.isFinite(value) ? value : null;
}

export async function evaluateMemoryHygieneCandidate({
  memory,
  episodes = [],
  repository,
  isCommitAncestor = async () => false,
  minSpecificityValue = null,
}) {
  // Too vague to act on is a review candidate, never a resolution: a model
  // score must not delete anything, so this disposition is never applied and it
  // is checked before completion evidence.
  if (memory && minSpecificityValue !== null) {
    const specificity = storedSpecificity(memory);
    if (specificity !== null && specificity < minSpecificityValue) {
      return {
        disposition: "vague",
        reason: "low_specificity",
        evidenceKind: "typesafe_specificity",
        evidenceValue: specificity,
      };
    }
  }
  if (!memory || !STABILISATION_TYPES.has(memory.type)) {
    return {
      disposition: "ambiguous",
      reason: "unsupported_memory_type",
    };
  }

  const effectiveRepository = memory.repository ?? repository ?? null;
  const laterEpisodes = episodes.filter((episode) => (
    isLaterEpisode(memory, episode)
    && (
      memory.scope === "global"
      || episode.repository === effectiveRepository
    )
  ));
  const negativeEvidence = findNegativeEvidence(memory, laterEpisodes);
  if (negativeEvidence) {
    return {
      disposition: "negative_evidence",
      reason: "later_episode_still_open",
      evidenceKind: "episode_open_item",
      evidenceValue: negativeEvidence.evidenceText,
      evidenceSource: negativeEvidence.episode.sessionId ?? null,
    };
  }

  const isGlobal = memory.scope === "global";
  // Repo-scoped completion still requires identifier overlap or an exact
  // target. Token-only matches such as "all tests green" must not close an
  // unrelated open_loop.
  const completionEvidence = findCompletionEvidence(memory, laterEpisodes, isGlobal);
  if (completionEvidence) {
    return {
      disposition: "resolved",
      reason: isGlobal ? "global_exact_completion" : "repo_explicit_completion",
      evidenceKind: "episode_completion",
      evidenceValue: completionEvidence.evidenceText,
      evidenceSource: completionEvidence.episode.sessionId ?? null,
    };
  }

  if (isGlobal) {
    return {
      disposition: "ambiguous",
      reason: "global_requires_explicit_completion",
    };
  }

  const promotionCommit = findPromotionCommit(memory.content);
  const repositoryMatches = !memory.repository || memory.repository === repository;
  if (promotionCommit && repositoryMatches && await isCommitAncestor(promotionCommit)) {
    return {
      disposition: "resolved",
      reason: "repo_commit_is_ancestor",
      evidenceKind: "git_ancestry",
      evidenceValue: promotionCommit,
      evidenceSource: repository ?? null,
    };
  }

  return {
    disposition: "ambiguous",
    reason: promotionCommit ? "commit_not_ancestor" : "no_high_confidence_evidence",
  };
}

export function createGitAncestorChecker(workspacePath) {
  const cwd = normalizeText(workspacePath);
  if (!cwd) {
    return async () => false;
  }
  return async (commit) => new Promise((resolve) => {
    execFile(
      "git",
      ["merge-base", "--is-ancestor", String(commit), "HEAD"],
      { cwd, maxBuffer: 64 * 1024 },
      (error) => resolve(!error),
    );
  });
}

function buildArtifact({
  memory,
  evaluation,
  repository,
  mode,
  marker,
}) {
  const resolved = evaluation.disposition === "resolved";
  return {
    kind: "memory_hygiene",
    repository: memory.repository ?? repository ?? null,
    sourceCaseId: memory.id,
    sourceKind: memory.type,
    eventKey: `${marker}:${memory.id}`,
    summary: `${memory.type} ${memory.id}: ${evaluation.reason}`,
    severity: evaluation.disposition === "negative_evidence" ? "warning" : "info",
    outcome: resolved && mode === "apply" ? "resolved" : resolved ? "candidate" : evaluation.disposition,
    context: {
      marker,
      mode,
      memoryId: memory.id,
      memoryType: memory.type,
      memoryScope: memory.scope,
      reason: evaluation.reason,
      evidenceKind: evaluation.evidenceKind ?? null,
      evidenceSource: evaluation.evidenceSource ?? null,
      evidenceValue: evaluation.evidenceValue ?? null,
    },
  };
}

export async function runMemoryHygiene({
  db,
  repository,
  mode = "shadow",
  maxItems = 50,
  includeGlobal = true,
  runId = crypto.randomUUID(),
  isCommitAncestor = async () => false,
  config = null,
  fetchImpl = undefined,
} = {}) {
  if (!db) {
    throw new Error("db is required");
  }
  if (!["shadow", "apply"].includes(mode)) {
    throw new Error(`unsupported memory hygiene mode: ${mode}`);
  }

  const marker = `auto-hygiene:${runId}`;
  const memories = db.listActiveStabilisationMemories({
    repository,
    includeGlobal,
    limit: maxItems,
  });
  // Score the memories that have no stored specificity yet, so vagueness is a
  // background signal rather than a per-prompt cost. Bounded per run and
  // fail-open: a provider problem just means fewer signals this time.
  if (typesafeFeaturesEnabled(config)) {
    const unscored = memories.filter((memory) => storedSpecificity(memory) === null);
    if (unscored.length > 0) {
      const scored = await scoreMemoryFeatures({ memories: unscored, config, fetchImpl });
      if (scored.features.length > 0) {
        persistMemoryFeatures(db, scored.features);
        for (const feature of scored.features) {
          const memory = memories.find((candidate) => candidate.id === feature.id);
          if (memory) {
            memory.metadata = {
              ...(memory.metadata && typeof memory.metadata === "object" ? memory.metadata : {}),
              typesafe: {
                durability: feature.durability,
                specificity: feature.specificity,
                model: feature.model,
                promptVersion: feature.promptVersion,
                scoredAt: feature.scoredAt,
              },
            };
          }
        }
      }
    }
  }
  const minSpecificityValue = typesafeFeaturesEnabled(config) ? minSpecificity(config) : null;
  const episodes = db.listMemoryHygieneEpisodes({
    repository,
    includeOtherRepositories: true,
    limit: Math.max(maxItems * 2, 20),
  });
  const items = [];

  for (const memory of memories) {
    const evaluation = await evaluateMemoryHygieneCandidate({
      memory,
      episodes,
      repository,
      isCommitAncestor,
      minSpecificityValue,
    });
    if (evaluation.disposition === "resolved" && mode === "apply") {
      // Tag the suppression with this run's marker so rollback can reverse
      // exactly these effects without touching manual forgets.
      db.forgetMemory({
        id: memory.id,
        supersededBy: marker,
        actor: "memory_hygiene",
        reason: marker,
      });
    }
    db.insertTrajectoryArtifact(buildArtifact({
      memory,
      evaluation,
      repository,
      mode,
      marker,
    }));
    items.push({
      memoryId: memory.id,
      memoryType: memory.type,
      scope: memory.scope,
      content: memory.content,
      ...evaluation,
    });
  }

  const summary = {
    runId,
    marker,
    mode,
    inspectedCount: items.length,
    candidateCount: items.filter((item) => item.disposition === "resolved").length,
    resolvedCount: mode === "apply"
      ? items.filter((item) => item.disposition === "resolved").length
      : 0,
    ambiguousCount: items.filter((item) => item.disposition === "ambiguous").length,
    vagueCount: items.filter((item) => item.disposition === "vague").length,
    negativeEvidenceCount: items.filter((item) => item.disposition === "negative_evidence").length,
    items,
  };
  const summaryArtifactId = db.insertTrajectoryArtifact({
    kind: "memory_hygiene_run",
    repository: repository ?? null,
    sourceKind: "maintenance",
    eventKey: marker,
    summary: `Memory hygiene ${mode}: ${summary.resolvedCount} resolved, ${summary.candidateCount} candidates, ${summary.ambiguousCount} ambiguous, ${summary.negativeEvidenceCount} negative`,
    severity: summary.negativeEvidenceCount > 0 ? "warning" : "info",
    outcome: mode === "apply" ? "completed" : "reported",
    context: {
      marker,
      mode,
      inspectedCount: summary.inspectedCount,
      candidateCount: summary.candidateCount,
      resolvedCount: summary.resolvedCount,
      ambiguousCount: summary.ambiguousCount,
      negativeEvidenceCount: summary.negativeEvidenceCount,
      unresolvedItems: items
        .filter((item) => item.disposition !== "resolved")
        .slice(0, 5)
        .map((item) => ({
          memoryId: item.memoryId,
          memoryType: item.memoryType,
          scope: item.scope,
          content: item.content,
          disposition: item.disposition,
          reason: item.reason,
        })),
      reviewItems: items.slice(0, 10).map((item) => ({
        memoryId: item.memoryId,
        memoryType: item.memoryType,
        scope: item.scope,
        content: item.content,
        disposition: mode === "shadow" && item.disposition === "resolved"
          ? "candidate"
          : item.disposition,
        reason: item.reason,
      })),
    },
  });
  return {
    ...summary,
    summaryArtifactId,
  };
}

export function formatLatestMemoryHygieneSummary({
  db,
  repository,
  maxItems = 5,
} = {}) {
  return consumeLatestMemoryHygieneSummary({
    db,
    repository,
    maxItems,
    lastSurfacedArtifactId: null,
  })?.text ?? "";
}

export function consumeLatestMemoryHygieneSummary({
  db,
  repository,
  maxItems = 5,
  lastSurfacedArtifactId = null,
} = {}) {
  if (!db) {
    return null;
  }
  const [latest] = db.listTrajectoryArtifacts({
    kind: "memory_hygiene_run",
    repository,
    limit: 1,
  });
  if (!latest || latest.id === lastSurfacedArtifactId) {
    return null;
  }
  const context = latest.context ?? {};
  const sourceItems = context.mode === "shadow"
    ? context.reviewItems ?? context.unresolvedItems
    : context.unresolvedItems;
  const unresolvedItems = Array.isArray(sourceItems)
    ? sourceItems.slice(0, Math.max(1, Math.min(10, maxItems)))
    : [];
  if (unresolvedItems.length === 0) {
    return null;
  }
  const lines = [
    "## Automated Memory Hygiene",
    "",
    `- mode=${context.mode ?? "unknown"} candidates=${context.candidateCount ?? 0} resolved=${context.resolvedCount ?? 0} ambiguous=${context.ambiguousCount ?? 0} negativeEvidence=${context.negativeEvidenceCount ?? 0}`,
  ];
  for (const item of unresolvedItems) {
    lines.push(
      `- [${item.disposition ?? "unresolved"}] [${item.scope ?? "unknown"}/${item.memoryType ?? "memory"}] ${normalizeText(item.content).slice(0, 160)}`,
    );
  }
  lines.push("", "Non-blocking: unresolved items remain active for later evidence or review.");
  return {
    artifactId: latest.id,
    text: lines.join("\n"),
  };
}

export function rollbackMemoryHygiene({
  db,
  marker,
  actor,
  reason,
} = {}) {
  if (!db) {
    throw new Error("db is required");
  }
  if (!String(marker ?? "").startsWith("auto-hygiene:")) {
    throw new Error("marker must start with auto-hygiene:");
  }
  const restoredMemoryIds = db.restoreMemoriesBySupersessionMarker(marker);
  const artifactId = db.insertTrajectoryArtifact({
    kind: "memory_hygiene_rollback",
    sourceKind: "operator",
    eventKey: `rollback:${marker}`,
    summary: `Restored ${restoredMemoryIds.length} memories from ${marker}`,
    severity: "warning",
    outcome: "restored",
    context: {
      marker,
      actor: normalizeText(actor) || "unknown",
      reason: normalizeText(reason) || "unspecified",
      restoredMemoryIds,
    },
  });
  return {
    artifactId,
    marker,
    restoredMemoryIds,
  };
}
