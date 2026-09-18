/**
 * TypeSafe System One reranking for prompt recall.
 *
 * Recall fuses lexical and embedding hits into a shortlist. Embeddings measure
 * similarity, not usefulness, so this module asks TypeSafe's System One model
 * (Jev) for one graded usefulness judgment per candidate and reorders the
 * shortlist in code. It is opt-in, remote, and strictly fail-open: any
 * transport or response problem leaves the original order untouched.
 *
 * Candidates whose content looks sensitive are never sent to the provider;
 * they keep their fused position and are simply not scored.
 */

import {
  TYPESAFE_API_KEY_ENV,
  positiveInteger,
  requestSystemOne,
  resolveTypesafeApiKey,
  typesafeModel,
  typesafeTimeoutMs,
} from "./typesafe-client.mjs";
import { isSensitiveMemoryContent } from "../memory/memory-sensitivity.mjs";

export { TYPESAFE_API_KEY_ENV };

/**
 * Ordered usefulness levels in one coherent dimension. Each level describes a
 * concrete situation so the model can score candidates comparably.
 */
export const RERANK_SCORE_LEVELS = Object.freeze([
  "Not needed to answer the prompt",
  "Useful background for the prompt",
  "Contains a preference, decision, constraint, or fact that should shape the answer",
]);

const DEFAULT_MAX_CANDIDATES = 6;
const MAX_CANDIDATES = 12;

function normalizeOptions(config, env) {
  const typesafe = config?.typesafe ?? {};
  return {
    providerEnabled: typesafe.enabled === true,
    featureEnabled: typesafe.rerank?.enabled === true,
    model: typesafeModel(config),
    timeoutMs: typesafeTimeoutMs(config),
    maxCandidates: positiveInteger(typesafe.rerank?.maxCandidates, DEFAULT_MAX_CANDIDATES, MAX_CANDIDATES),
    apiKey: resolveTypesafeApiKey(config, env),
  };
}

function buildQuestions(count) {
  const questions = {};
  for (let index = 0; index < count; index += 1) {
    questions[`memory_${index}`] = {
      type: "score",
      instructions: `How useful is the memory at \`memories[${index}]\` for answering the prompt at \`prompt\`?`,
      criteria: [...RERANK_SCORE_LEVELS],
    };
  }
  return questions;
}

function parseScoreEntry(row, index, answer) {
  const score = answer?.type === "score" ? Number(answer.score) : Number.NaN;
  const usable = Number.isFinite(score)
    && score >= 0
    && score <= RERANK_SCORE_LEVELS.length - 1;
  return {
    row,
    index,
    score: usable ? score : null,
    confidence: usable && Number.isFinite(Number(answer?.confidence))
      ? Number(answer.confidence)
      : null,
  };
}

function rankEntries(entries) {
  return [...entries].sort((left, right) => {
    if (left.score === null && right.score === null) {
      return left.index - right.index;
    }
    if (left.score === null) {
      return 1;
    }
    if (right.score === null) {
      return -1;
    }
    return (right.score - left.score) || (left.index - right.index);
  });
}

function traceRow(entry) {
  return entry.score === null ? { ...entry.row } : { ...entry.row, score: entry.score };
}

/**
 * Ask TypeSafe to grade each candidate's usefulness and reorder by score.
 *
 * @param {{
 *   prompt: string,
 *   rows?: Array<object>,
 *   config?: object,
 *   fetchImpl?: typeof globalThis.fetch,
 *   signal?: AbortSignal,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {Promise<{
 *   enabled: boolean,
 *   applied: boolean,
 *   reason: string,
 *   rows: Array<object>,
 *   model: string,
 *   usage: object|null,
 *   scores: Array<{id: unknown, score: number|null, confidence: number|null, beforeIndex: number, afterIndex: number}>,
 *   error: string|null,
 *   trace: object,
 * }>}
 */
export async function rerankMemories({
  prompt,
  rows = [],
  config,
  fetchImpl = globalThis.fetch,
  signal,
  env = process.env,
} = {}) {
  const options = normalizeOptions(config, env);
  const originalRows = Array.isArray(rows) ? rows : [];
  const pool = originalRows.slice(0, options.maxCandidates);
  const remainder = originalRows.slice(options.maxCandidates);
  const enabled = options.providerEnabled && options.featureEnabled && Boolean(options.apiKey);

  const finish = ({
    reason,
    applied = false,
    ranked = null,
    scores = [],
    model = options.model,
    usage = null,
    error = null,
    excludedSensitive = 0,
  }) => {
    const entries = applied ? ranked : null;
    const finalRows = entries ? entries.map((entry) => entry.row) : originalRows;
    const finalTraceRows = entries ? entries.map(traceRow) : [];
    return {
      enabled,
      applied,
      reason,
      rows: finalRows,
      model,
      usage,
      scores,
      error,
      trace: {
        enabled,
        applied,
        reason,
        candidateCount: pool.length,
        excludedSensitive,
        model,
        usage,
        scores,
        error,
        rows: finalTraceRows,
        includedRows: finalTraceRows,
      },
    };
  };

  if (!options.providerEnabled || !options.featureEnabled) {
    return finish({ reason: options.providerEnabled ? "rerank_disabled" : "typesafe_disabled" });
  }
  if (!options.apiKey) {
    return finish({ reason: "api_key_missing" });
  }
  if (pool.length < 2) {
    return finish({ reason: "too_few_candidates" });
  }

  // Sensitive content never leaves the machine: those candidates stay in their
  // fused position and are reported as unscored.
  const requestable = pool
    .map((row, index) => ({ row, index }))
    .filter((entry) => !isSensitiveMemoryContent(entry.row?.content));
  const excluded = pool
    .map((row, index) => ({ row, index, score: null, confidence: null }))
    .filter((entry) => isSensitiveMemoryContent(entry.row?.content));
  const excludedSensitive = excluded.length;
  if (requestable.length < 2) {
    return finish({ reason: "too_few_candidates", excludedSensitive });
  }

  const state = {
    prompt: String(prompt ?? ""),
    memories: requestable.map((entry) => ({
      id: entry.row.id,
      type: entry.row.type,
      content: String(entry.row.content ?? ""),
    })),
  };

  let payload;
  try {
    payload = await requestSystemOne({
      apiKey: options.apiKey,
      model: options.model,
      state,
      questions: buildQuestions(requestable.length),
      timeoutMs: options.timeoutMs,
      fetchImpl,
      signal,
    });
  } catch (error) {
    return finish({
      reason: "request_failed",
      error: error instanceof Error ? error.message : String(error),
      excludedSensitive,
    });
  }

  const answers = payload?.answers && typeof payload.answers === "object" ? payload.answers : {};
  const model = typeof payload?.model === "string" && payload.model.trim() ? payload.model : options.model;
  const usage = payload?.usage && typeof payload.usage === "object" ? payload.usage : null;
  const scored = requestable.map((entry, position) => parseScoreEntry(entry.row, entry.index, answers[`memory_${position}`]));
  if (scored.every((entry) => entry.score === null)) {
    return finish({ reason: "no_usable_answers", model, usage, excludedSensitive });
  }

  const ranked = [
    ...rankEntries(scored),
    ...excluded,
    ...remainder.map((row, index) => ({
      row,
      index: options.maxCandidates + index,
      score: null,
      confidence: null,
    })),
  ];
  const afterIndex = new Map(ranked.map((entry, position) => [entry.row, position]));
  const scores = scored.map((entry) => ({
    id: entry.row.id,
    score: entry.score,
    confidence: entry.confidence,
    beforeIndex: entry.index,
    afterIndex: afterIndex.get(entry.row),
  }));

  return finish({ reason: "reranked", applied: true, ranked, scores, model, usage, excludedSensitive });
}
