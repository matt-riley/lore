import {
  extractDirectTerms as extractNormalizedDirectTerms,
  extractFtsTerms as extractNormalizedFtsTerms,
  GENERIC_QUERY_TERMS,
  normalizeMatchTerm,
  normalizeFtsToken,
  QUERY_ALIASES,
  tokenizeText,
} from "./query-normalizer.mjs";
import { normalizeText } from "./session-text-normalizer.mjs";
import { readHybridRetrievalEnabled } from "./rollout-flags.mjs";

// --- Episode exclusion and summary classification ---

function isPlaceholderSummary(summary) {
  return /^Session [0-9a-f-]{8,}$/i.test(normalizeText(summary));
}

function isGenericWorkSummary(summary) {
  return /^Worked in .+ \([0-9a-f-]{8,}\)$/i.test(normalizeText(summary));
}

function isToolInvocationSummary(summary) {
  const text = normalizeText(summary);
  return /^Call the tool\b/i.test(text)
    || /\breturn only the tool output\b/i.test(text)
    || /^Using only local repo files\b/i.test(text);
}

function explainEpisodeExclusionReason(episode) {
  if (isPlaceholderSummary(episode.summary)) {
    return "placeholder_summary";
  }
  if (isToolInvocationSummary(episode.summary)) {
    return "tool_invocation_summary";
  }
  return null;
}

function buildTermWeights(episodes, terms) {
  const weights = new Map();
  if (terms.length === 0 || episodes.length === 0) {
    return weights;
  }

  const documentFrequency = new Map();
  for (const episode of episodes) {
    const tokens = tokenizeText([
      episode.summary,
      episode.actions_json,
      episode.decisions_json,
      episode.files_changed_json,
      episode.themes_json,
      episode.open_items_json,
    ].join(" "));
    for (const term of terms) {
      if (tokens.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  for (const term of terms) {
    const frequency = documentFrequency.get(term) ?? 0;
    weights.set(term, frequency === 0 ? 1.5 : 1 + ((episodes.length - frequency) / episodes.length));
  }

  return weights;
}

// fallow-ignore-next-line complexity
function scoreEpisodeAgainstWeightedTerms(episode, terms, primaryTerms, termWeights, exactMatchIds) {
  if (terms.length === 0) {
    return 0;
  }

  const tokens = tokenizeText([
    episode.summary,
    episode.actions_json,
    episode.decisions_json,
    episode.files_changed_json,
    episode.themes_json,
    episode.open_items_json,
  ].join(" "));

  let score = 0;
  let matchedTerms = 0;
  let matchedPrimaryTerms = 0;
  for (const term of terms) {
    if (tokens.has(term)) {
      score += termWeights.get(term) ?? 1;
      matchedTerms += 1;
      if (primaryTerms.includes(term)) {
        matchedPrimaryTerms += 1;
      }
    }
  }

  if (matchedTerms === 0 || (matchedPrimaryTerms === 0 && matchedTerms < 2)) {
    return 0;
  }

  score += matchedTerms * 0.35;
  score += matchedPrimaryTerms * 1.25;
  if (exactMatchIds.has(episode.session_id)) {
    score += 2;
  }
  if (!isGenericWorkSummary(episode.summary)) {
    score += 0.5;
  }
  score += Math.min((episode.significance ?? 0) / 10, 1);
  return score;
}

// --- Entity extraction ---

function extractBacktickedEntities(raw) {
  const entities = [];
  for (const match of raw.matchAll(/`([^`]+)`/g)) {
    const stem = match[1].replace(/\.[a-z]+$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (stem.length > 2) entities.push(stem);
  }
  return entities;
}

function extractFileNameEntities(raw) {
  const entities = [];
  for (const match of raw.matchAll(/\b([\w-]+)\.(mjs|cjs|js|ts|tsx|json|md|yaml|yml)\b/gi)) {
    const stem = match[1].replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (stem.length > 2) entities.push(stem);
  }
  return entities;
}

function extractCamelCaseEntities(raw) {
  const entities = [];
  for (const match of raw.matchAll(/\b([A-Za-z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
    const full = normalizeMatchTerm(match[0].toLowerCase());
    if (full.length > 2) entities.push(full);
    for (const part of match[0].replace(/([A-Z])/g, " $1").trim().split(/\s+/)) {
      const normalized = normalizeMatchTerm(part.toLowerCase());
      if (normalized.length > 2 && !GENERIC_QUERY_TERMS.has(normalized)) {
        entities.push(normalized);
      }
    }
  }
  return entities;
}

function extractEntityTerms(query) {
  const raw = String(query || "");
  const entities = [
    ...extractBacktickedEntities(raw),
    ...extractFileNameEntities(raw),
    ...extractCamelCaseEntities(raw),
  ];
  return [...new Set(entities.map(normalizeMatchTerm).filter((t) => t.length > 2 && !GENERIC_QUERY_TERMS.has(t)))];
}

// --- Pool filtering and ranking ---

const RRF_K = 60;
const RRF_SCALE = 30;

function computeRrfScore(sessionId, ftsRankMap, recencyRankMap, ftsMissRank, recencyMissRank) {
  const ftsRank = ftsRankMap.has(sessionId) ? ftsRankMap.get(sessionId) : ftsMissRank;
  const recencyRank = recencyRankMap.has(sessionId) ? recencyRankMap.get(sessionId) : recencyMissRank;
  return (1 / (RRF_K + ftsRank)) + (1 / (RRF_K + recencyRank));
}

function scoreAndRankEpisodeCandidates({
  candidatePool, seen, exactMatchIds, effectiveTerms, effectivePrimaryTerms, termWeights,
  hybridEnabled, ftsRankMap, recencyRankMap, ftsMissRank, recencyMissRank,
}) {
  return candidatePool
    .filter((episode) => !seen.has(episode.session_id) || exactMatchIds.has(episode.session_id))
    .map((episode) => {
      const termScore = scoreEpisodeAgainstWeightedTerms(episode, effectiveTerms, effectivePrimaryTerms, termWeights, exactMatchIds);
      const rrfBoost = hybridEnabled
        ? computeRrfScore(episode.session_id, ftsRankMap, recencyRankMap, ftsMissRank, recencyMissRank) * RRF_SCALE
        : 0;
      return { episode, score: termScore + rrfBoost, termScore };
    })
    .filter((entry) => entry.termScore > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if ((right.significance ?? right.episode.significance) !== (left.significance ?? left.episode.significance)) {
        return (right.episode.significance ?? 0) - (left.episode.significance ?? 0);
      }
      return String(right.episode.updated_at).localeCompare(String(left.episode.updated_at));
    });
}

// --- Query termset building ---

function buildEpisodeQueryTermsets(prompt, config) {
  const primaryTerms = extractNormalizedDirectTerms(prompt, {
    excludedTerms: GENERIC_QUERY_TERMS,
  });
  const terms = extractNormalizedFtsTerms(prompt, {
    aliases: QUERY_ALIASES,
    normalize: normalizeFtsToken,
  });
  const hybridEnabled = readHybridRetrievalEnabled(config);
  const entityTerms = hybridEnabled ? extractEntityTerms(prompt) : [];
  const effectivePrimaryTerms = hybridEnabled
    ? [...new Set([...primaryTerms, ...entityTerms])]
    : primaryTerms;
  const effectiveTerms = hybridEnabled
    ? [...new Set([...terms, ...entityTerms])]
    : terms;
  const lexicalQuery = (primaryTerms.length > 0 ? primaryTerms : terms).join(" ");
  return { primaryTerms, terms, entityTerms, hybridEnabled, effectivePrimaryTerms, effectiveTerms, lexicalQuery };
}

export {
  buildEpisodeQueryTermsets,
  buildTermWeights,
  explainEpisodeExclusionReason,
  isGenericWorkSummary,
  isPlaceholderSummary,
  isToolInvocationSummary,
  scoreAndRankEpisodeCandidates,
};
