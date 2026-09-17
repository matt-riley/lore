/**
 * TypeSafe System One reranking for prompt recall.
 *
 * Recall fuses lexical and embedding hits into a shortlist. Embeddings measure
 * similarity, not usefulness, so this module asks TypeSafe's System One model
 * (Jev) for one graded usefulness judgment per candidate and reorders the
 * shortlist in code. It is opt-in, remote, and strictly fail-open: any
 * transport or response problem leaves the original order untouched.
 */

export const TYPESAFE_API_KEY_ENV = "LORE_TYPESAFE_API_KEY";
const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TYPESAFE_MODEL = "jev-latest";

/**
 * Ordered usefulness levels in one coherent dimension. Each level describes a
 * concrete situation so the model can score candidates comparably.
 */
export const RERANK_SCORE_LEVELS = Object.freeze([
  "Not needed to answer the prompt",
  "Useful background for the prompt",
  "Contains a preference, decision, constraint, or fact that should shape the answer",
]);

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_MAX_CANDIDATES = 6;
const MAX_CANDIDATES = 12;
const ERROR_BODY_CHARS = 200;

function positiveInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return maximum ? Math.min(numeric, maximum) : numeric;
}

/** Resolve the API key from the config or the environment. */
function resolveTypesafeApiKey(config, env = process.env) {
  const configKey = config?.typesafe?.apiKey;
  if (typeof configKey === "string" && configKey.trim()) {
    return configKey.trim();
  }
  const envKey = env?.[TYPESAFE_API_KEY_ENV];
  return typeof envKey === "string" ? envKey.trim() : "";
}

function normalizeOptions(config, env) {
  const typesafe = config?.typesafe ?? {};
  const model = typeof typesafe.model === "string" ? typesafe.model.trim() : "";
  return {
    providerEnabled: typesafe.enabled === true,
    featureEnabled: typesafe.rerank?.enabled === true,
    model: model || DEFAULT_TYPESAFE_MODEL,
    timeoutMs: positiveInteger(typesafe.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
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

async function readErrorDetail(response) {
  if (typeof response?.text !== "function") {
    return "";
  }
  try {
    const body = String(await response.text()).trim();
    return body ? `: ${body.slice(0, ERROR_BODY_CHARS)}` : "";
  } catch {
    return "";
  }
}

async function requestSystemOne({
  apiKey,
  model,
  state,
  questions,
  timeoutMs,
  fetchImpl,
  signal,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("typesafe fetch implementation is unavailable");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);
  try {
    if (signal?.aborted) {
      throw new Error("typesafe request aborted");
    }
    if (signal) {
      signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const response = await fetchImpl(TYPESAFE_SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, state, questions }),
      // The endpoint is a fixed remote host; refusing redirects keeps memory
      // content and the bearer token from following an unexpected Location.
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) {
      const detail = await readErrorDetail(response);
      throw new Error(`typesafe request failed with status ${response?.status ?? "unknown"}${detail}`);
    }
    return await response.json();
  } catch (error) {
    if (timedOut) {
      throw new Error(`typesafe request timed out after ${timeoutMs}ms`);
    }
    if (signal?.aborted) {
      throw new Error("typesafe request aborted");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener("abort", forwardAbort);
    }
  }
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
  }) => {
    const entries = applied ? ranked : null;
    const finalRows = entries ? entries.map((entry) => entry.row) : originalRows;
    const finalTraceRows = entries
      ? entries.map(traceRow)
      : [];
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

  const state = {
    prompt: String(prompt ?? ""),
    memories: pool.map((row) => ({
      id: row.id,
      type: row.type,
      content: String(row.content ?? ""),
    })),
  };

  let payload;
  try {
    payload = await requestSystemOne({
      apiKey: options.apiKey,
      model: options.model,
      state,
      questions: buildQuestions(pool.length),
      timeoutMs: options.timeoutMs,
      fetchImpl,
      signal,
    });
  } catch (error) {
    return finish({
      reason: "request_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const answers = payload?.answers && typeof payload.answers === "object" ? payload.answers : {};
  const model = typeof payload?.model === "string" && payload.model.trim() ? payload.model : options.model;
  const usage = payload?.usage && typeof payload.usage === "object" ? payload.usage : null;
  const scored = pool.map((row, index) => parseScoreEntry(row, index, answers[`memory_${index}`]));
  if (scored.every((entry) => entry.score === null)) {
    return finish({ reason: "no_usable_answers", model, usage });
  }

  const rankedPool = rankEntries(scored);
  const ranked = [
    ...rankedPool,
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

  return finish({ reason: "reranked", applied: true, ranked, scores, model, usage });
}
