/**
 * lib/semantic-search.mjs
 *
 * True semantic (vector) search over stored memories using a local
 * embeddings endpoint.
 *
 * lore's lexical retrieval (searchSemantic) is exact-token FTS with no
 * stemming, so queries and memories that share no words never match. This
 * module fixes that: the query and candidate memories are embedded with the
 * configured local embeddings model, ranked by cosine similarity, and the
 * vectors are cached in the memory_embedding side table so repeated searches
 * only re-embed the query (and any new memories).
 *
 * Design constraints:
 *   - Opt-in: returns { enabled: false, rows: [] } unless
 *     localInference.embeddings.{enabled,model} are configured.
 *   - Fail-open: any embedding error returns { enabled: false, rows: [] }
 *     with an error message; callers fall back to lexical retrieval.
 *   - Privacy: only memory content is sent to the embeddings endpoint — never
 *     raw prompts, tool arguments, or file contents beyond the query string.
 *   - Scope: global memories plus memories for the supplied repository.
 *     Cross-repository fallback is intentionally out of scope for v1.
 *
 * The embedding cache is a side table owned by this feature; the schema
 * statement lives in schema.mjs (SCHEMA_STATEMENTS) and is applied
 * idempotently by the migration runner.
 */

import crypto from "node:crypto";

import { requestLocalInferenceEmbeddings } from "./local-inference.mjs";

/**
 * Types semantic search considers by default — the same recallable set the
 * lexical prompt-context path searches.
 */
export const SEMANTIC_SEARCH_TYPES = Object.freeze([
  "commitment",
  "open_loop",
  "rejected_approach",
  "blocker",
  "user_preference",
  "assistant_identity",
  "user_identity",
  "assistant_goal",
  "recurring_mistake",
  "interaction_style",
]);

/** Maximum results a single semantic search may return. */
export const SEMANTIC_SEARCH_MAX_LIMIT = 20;

/** Keep retrieval within the Pi/server request budget unless overridden. */
export const SEMANTIC_SEARCH_DEFAULT_DEADLINE_MS = 10_000;

function embeddingProvider(config) {
  const explicit = config?.embeddings?.provider ?? config?.provider;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  try {
    const url = new URL(String(config?.baseUrl || ""));
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "local";
  }
}

/**
 * Stable content identity for a memory embedding cache entry.
 *
 * @param {string} content
 * @returns {string}
 */
export function embeddingContentHash(content) {
  return crypto.createHash("sha256").update(String(content ?? ""), "utf8").digest("hex");
}

function validVector(vector, dimensions = null) {
  return Array.isArray(vector)
    && vector.length > 0
    && (dimensions === null || vector.length === dimensions)
    && vector.every((value) => Number.isFinite(value))
    && vector.some((value) => value !== 0);
}

function parseCachedVector(stored, dimensions) {
  if (typeof stored !== "string") {
    return null;
  }
  try {
    const vector = JSON.parse(stored);
    return validVector(vector, dimensions) ? vector : null;
  } catch {
    return null;
  }
}

function createSearchAbortSignal(signal, deadlineMs) {
  const hasDeadline = Number.isFinite(Number(deadlineMs)) && Number(deadlineMs) >= 0;
  if (!hasDeadline && !signal) {
    return { signal: undefined, cleanup: () => {} };
  }
  const controller = new AbortController();
  let deadlineTimer = null;
  let externalAbortHandler = null;
  if (signal) {
    externalAbortHandler = () => controller.abort(signal.reason);
    if (signal.aborted) {
      externalAbortHandler();
    } else {
      signal.addEventListener("abort", externalAbortHandler, { once: true });
    }
  }
  if (hasDeadline) {
    deadlineTimer = setTimeout(() => {
      controller.abort(new Error(`semantic search deadline exceeded after ${Number(deadlineMs)}ms`));
    }, Number(deadlineMs));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
      }
      if (externalAbortHandler && signal) {
        signal.removeEventListener("abort", externalAbortHandler);
      }
    },
  };
}

/**
 * Cosine similarity between two equal-length vectors. Returns 0 for empty or
 * length-mismatched inputs so malformed cached vectors rank as no match.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (!validVector(a) || !validVector(b) || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Whether semantic search is configured (local inference + embeddings on).
 *
 * @param {object} config - lore config (or localInference sub-config)
 * @returns {boolean}
 */
export function semanticSearchEnabled(config) {
  const li = config?.localInference ?? config;
  return li?.enabled === true
    && li?.embeddings?.enabled === true
    && typeof li.embeddings?.model === "string"
    && li.embeddings.model.trim().length > 0;
}

/**
 * Search stored memories by semantic similarity to the query.
 *
 * @param {{
 *   db: import("./db.mjs").LoreDb,
 *   query: string,
 *   repository?: string | null,
 *   types?: string[],
 *   limit?: number,
 *   fetchImpl?: typeof globalThis.fetch,
 *   config?: object,
 *   signal?: AbortSignal,
 *   deadlineMs?: number,
 * }} opts
 * @returns {Promise<{ enabled: boolean, rows: Array<{
 *   id: string, type: string, content: string, repository: string | null, score: number
 * }>, error?: string }>}
 */
export async function semanticSearch({
  db,
  query,
  repository = null,
  types = SEMANTIC_SEARCH_TYPES,
  limit = 6,
  fetchImpl = globalThis.fetch,
  config = db.config,
  signal,
  deadlineMs,
}) {
  const li = config?.localInference;
  if (li?.enabled !== true || li?.embeddings?.enabled !== true || !semanticSearchEnabled(li)) {
    return { enabled: false, rows: [] };
  }
  // Embeddings calls use the embeddings model, not the chat model.
  const embedConfig = { ...li, model: li.embeddings.model };
  const provider = embeddingProvider(li);
  const model = String(li.embeddings.model).trim();
  const abort = createSearchAbortSignal(
    signal,
    deadlineMs === undefined ? SEMANTIC_SEARCH_DEFAULT_DEADLINE_MS : deadlineMs,
  );

  try {
    db.ensureMemoryEmbeddingTable();

    const [queryVec] = await requestLocalInferenceEmbeddings({
      config: embedConfig,
      input: [String(query ?? "")],
      fetchImpl,
      signal: abort.signal,
    });
    if (!validVector(queryVec)) {
      throw new Error("local embeddings returned no query vector");
    }
    const dimensions = queryVec.length;
    const cacheKey = (content) => ({
      contentHash: embeddingContentHash(content),
      provider,
      model,
      dimensions,
    });

    const candidates = db.listSemanticMemoriesForEmbedding({ types, repository });

    // maxInputs bounds memory indexing work per search. The query is a
    // separate required endpoint input, and the historical per-request cap
    // remains 24 even if a config asks for a larger value.
    const totalInputBound = Number.isInteger(Number(li.embeddings?.maxInputs))
      && Number(li.embeddings.maxInputs) > 0
      ? Number(li.embeddings.maxInputs)
      : 24;
    const memoryInputBudget = Math.max(1, Math.min(totalInputBound, 24));
    const missing = candidates.filter((row) => {
      const stored = db.getMemoryEmbedding(row.id, cacheKey(row.content));
      return !parseCachedVector(stored, dimensions);
    }).slice(0, memoryInputBudget);
    if (missing.length > 0) {
      const chunk = missing;
      const vectors = await requestLocalInferenceEmbeddings({
        config: embedConfig,
        input: chunk.map((row) => row.content),
        fetchImpl,
        signal: abort.signal,
        preserveInvalid: true,
      });
      for (let j = 0; j < chunk.length; j++) {
        const vector = validVector(vectors[j], dimensions) ? vectors[j] : [];
        // Keep an invalid response as an updated marker. It can never be a
        // hit, and its timestamp lets later searches try untouched memories
        // before retrying this failed candidate.
        db.setMemoryEmbedding(chunk[j].id, vector, cacheKey(chunk[j].content));
      }
    }

    const minSimilarity = Number.isFinite(Number(li.embeddings?.minSimilarity))
      ? Number(li.embeddings.minSimilarity)
      : 0;
    const rows = [];
    for (const row of candidates) {
      const stored = db.getMemoryEmbedding(row.id, cacheKey(row.content));
      const vector = parseCachedVector(stored, dimensions);
      if (!vector) {
        continue;
      }
      const score = cosineSimilarity(queryVec, vector);
      if (Number.isFinite(score) && score >= minSimilarity) {
        rows.push({
          id: row.id,
          type: row.type,
          content: row.content,
          repository: row.repository ?? null,
          score,
        });
      }
    }

    rows.sort((a, b) => b.score - a.score);
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 6, SEMANTIC_SEARCH_MAX_LIMIT));
    return { enabled: true, rows: rows.slice(0, boundedLimit) };
  } catch (error) {
    // Fail open: embedding problems must never break recall flows.
    return {
      enabled: false,
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    abort.cleanup();
  }
}
