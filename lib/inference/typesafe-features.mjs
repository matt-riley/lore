/**
 * TypeSafe-backed memory features.
 *
 * Scores each memory once on durable dimensions and stores the result on the
 * row, so later decisions (does this directive deserve to be a standing rule?)
 * read a number instead of re-asking a model. Batched: one request carries the
 * durability and specificity question for every candidate. Fail-open: callers
 * must behave exactly as before when scoring is unavailable.
 *
 * Sensitivity is deliberately *not* a TypeSafe judgment — asking the provider
 * whether content is too sensitive to send means sending it first. It is
 * detected locally (memory-sensitivity.mjs) and those rows are withheld.
 */

import {
  positiveInteger,
  requestSystemOne,
  resolveTypesafeApiKey,
  typesafeModel,
  typesafeTimeoutMs,
} from "./typesafe-client.mjs";
import { detectSensitiveContent } from "../memory/memory-sensitivity.mjs";

export const DEFAULT_MIN_DURABILITY = 0.5;
const DEFAULT_MIN_SPECIFICITY = 0.5;
const DEFAULT_MAX_MEMORIES_PER_RUN = 24;
const MAX_MEMORIES_PER_RUN = 24;

// Bumping this invalidates stored judgments, so a sharper question or a new
// threshold re-scores rows instead of trusting a stale number.
export const FEATURE_PROMPT_VERSION = 2;

const SPECIFICITY_LEVELS = Object.freeze([
  "Vague or generic",
  "Some concrete detail",
  "Specific enough to act on without more context",
]);

export function typesafeFeaturesEnabled(config, env = process.env) {
  return config?.typesafe?.enabled === true
    && config.typesafe.features?.enabled === true
    && Boolean(resolveTypesafeApiKey(config, env));
}

export function minDurability(config) {
  const value = Number(config?.typesafe?.features?.minDurability);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_MIN_DURABILITY;
}

/** Below this specificity a memory is too vague to be worth keeping as-is. */
export function minSpecificity(config) {
  const value = Number(config?.typesafe?.features?.minSpecificity);
  return Number.isFinite(value) && value >= 0 && value <= SPECIFICITY_LEVELS.length - 1
    ? value
    : DEFAULT_MIN_SPECIFICITY;
}

/**
 * Persist scored features onto their rows. Returns how many landed and which
 * ids failed, so a caller can decide whether to retry them (the recall path
 * remembers failures; the hygiene sweep simply tries again next run).
 */
export function persistMemoryFeatures(db, features = []) {
  if (typeof db?.setSemanticMemoryMetadata !== "function") {
    return { saved: 0, failed: features.map((feature) => feature.id) };
  }
  const failed = [];
  let saved = 0;
  for (const feature of features) {
    const annotation = {
      durability: feature.durability,
      specificity: feature.specificity,
      model: feature.model,
      promptVersion: feature.promptVersion,
      scoredAt: feature.scoredAt,
    };
    let ok = false;
    try {
      ok = db.setSemanticMemoryMetadata(feature.id, { typesafe: annotation }) === true;
    } catch {
      ok = false;
    }
    if (ok) {
      saved += 1;
    } else {
      failed.push(feature.id);
    }
  }
  return { saved, failed };
}

function buildQuestions(count) {
  const questions = {};
  for (let index = 0; index < count; index += 1) {
    questions[`durable_${index}`] = {
      type: "noul",
      instructions: `Is the statement at \`memories[${index}].content\` a durable standard for future work, rather than something said once about the current task?`,
      criteria: {
        true: "A lasting standard, preference or constraint for future work",
        false: "A one-off request or status update about the current session or task, such as 'there should be a live env key', 'push that to main', or 'the signing agent should be up, try again'",
      },
    };
    questions[`specific_${index}`] = {
      type: "score",
      instructions: `How specific and actionable is the statement at \`memories[${index}].content\`?`,
      criteria: [...SPECIFICITY_LEVELS],
    };
  }
  return questions;
}

function parseFeature(row, position, answers, model, scoredAt) {
  const durabilityAnswer = answers?.[`durable_${position}`];
  const specificityAnswer = answers?.[`specific_${position}`];
  const durability = durabilityAnswer?.type === "noul" ? Number(durabilityAnswer.noul) : Number.NaN;
  const specificity = specificityAnswer?.type === "score" ? Number(specificityAnswer.score) : Number.NaN;
  if (!Number.isFinite(durability) || durability < 0 || durability > 1) {
    return null;
  }
  return {
    id: row.id,
    durability,
    specificity: Number.isFinite(specificity) ? specificity : null,
    model,
    promptVersion: FEATURE_PROMPT_VERSION,
    scoredAt,
  };
}

/**
 * Score durable features for up to `features.maxMemoriesPerRun` memories.
 *
 * @param {{
 *   memories: Array<{ id: string, type?: string, content?: string }>,
 *   config?: object,
 *   fetchImpl?: typeof globalThis.fetch,
 *   signal?: AbortSignal,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {Promise<{
 *   enabled: boolean,
 *   applied: boolean,
 *   reason: string,
 *   features: Array<{ id: string, durability: number, specificity: number|null, model: string, scoredAt: string }>,
 *   considered: number,
 *   withheldSensitive: number,
 *   model: string,
 *   usage: object|null,
 *   error: string|null,
 * }>}
 */
export async function scoreMemoryFeatures({
  memories = [],
  config,
  fetchImpl = globalThis.fetch,
  signal,
  env = process.env,
} = {}) {
  const enabled = typesafeFeaturesEnabled(config, env);
  const providerEnabled = config?.typesafe?.enabled === true;
  const featureEnabled = config?.typesafe?.features?.enabled === true;
  const model = typesafeModel(config);
  const base = {
    enabled,
    applied: false,
    reason: null,
    features: [],
    considered: 0,
    withheldSensitive: 0,
    model,
    usage: null,
    error: null,
  };

  if (!providerEnabled) {
    return { ...base, reason: "typesafe_disabled" };
  }
  if (!featureEnabled) {
    return { ...base, reason: "features_disabled" };
  }
  if (!resolveTypesafeApiKey(config, env)) {
    return { ...base, reason: "api_key_missing" };
  }

  const rows = Array.isArray(memories) ? memories.filter((memory) => memory?.id) : [];
  const withheld = [];
  const eligible = [];
  for (const row of rows) {
    const { sensitive } = detectSensitiveContent(row.content);
    if (sensitive) {
      withheld.push(row.id);
    } else {
      eligible.push(row);
    }
  }

  const maxPerRun = positiveInteger(
    config?.typesafe?.features?.maxMemoriesPerRun,
    DEFAULT_MAX_MEMORIES_PER_RUN,
    MAX_MEMORIES_PER_RUN,
  );
  const considered = eligible.slice(0, maxPerRun);
  if (considered.length === 0) {
    return { ...base, reason: rows.length === 0 ? "no_memories" : "all_sensitive", withheldSensitive: withheld.length };
  }

  let payload;
  try {
    payload = await requestSystemOne({
      apiKey: resolveTypesafeApiKey(config, env),
      model,
      state: {
        memories: considered.map((row) => ({
          id: row.id,
          type: row.type,
          content: String(row.content ?? ""),
        })),
      },
      questions: buildQuestions(considered.length),
      timeoutMs: typesafeTimeoutMs(config),
      fetchImpl,
      signal,
    });
  } catch (error) {
    return {
      ...base,
      reason: "request_failed",
      considered: considered.length,
      withheldSensitive: withheld.length,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const answers = payload?.answers && typeof payload.answers === "object" ? payload.answers : {};
  const resolvedModel = typeof payload?.model === "string" && payload.model.trim() ? payload.model : model;
  const usage = payload?.usage && typeof payload.usage === "object" ? payload.usage : null;
  const scoredAt = new Date().toISOString();
  const features = considered
    .map((row, position) => parseFeature(row, position, answers, resolvedModel, scoredAt))
    .filter(Boolean);

  if (features.length === 0) {
    return {
      ...base,
      reason: "no_usable_answers",
      considered: considered.length,
      withheldSensitive: withheld.length,
      model: resolvedModel,
      usage,
    };
  }

  return {
    enabled: true,
    applied: true,
    reason: "scored",
    features,
    considered: considered.length,
    withheldSensitive: withheld.length,
    model: resolvedModel,
    usage,
    error: null,
  };
}
