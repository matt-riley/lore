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

import { requestLocalInferenceEmbeddings } from "../inference/local-inference.mjs";

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
export const SEMANTIC_SEARCH_PAGE_SIZE = 256;

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
 *   db: import("../db/db.mjs").LoreDb,
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
  includeOtherRepositories = false,
  scopes = [],
  types = SEMANTIC_SEARCH_TYPES,
  limit = 6,
  fetchImpl = globalThis.fetch,
  config = db.config,
  signal,
  deadlineMs,
}) {
  const li = config?.localInference ?? config;
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
  const effectiveDeadlineMs = deadlineMs === undefined ? SEMANTIC_SEARCH_DEFAULT_DEADLINE_MS : Number(deadlineMs);
  const deadlineAt = Number.isFinite(effectiveDeadlineMs) && effectiveDeadlineMs >= 0
    ? Date.now() + effectiveDeadlineMs
    : null;
  const checkBudget = () => {
    if (abort.signal?.aborted || (deadlineAt !== null && Date.now() >= deadlineAt)) {
      throw new Error("semantic search deadline exceeded");
    }
  };
  const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
  let partialRows = [];

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

    const candidates = [];
    for (let offset = 0; ; offset += SEMANTIC_SEARCH_PAGE_SIZE) {
      checkBudget();
      const page = db.listSemanticMemoriesForEmbedding({
        types,
        repository,
        includeOtherRepositories,
        ...(scopes.length > 0 ? { scopes } : {}),
        includeEmbedding: true,
        limit: SEMANTIC_SEARCH_PAGE_SIZE,
        offset,
      });
      candidates.push(...page);
      if (page.length < SEMANTIC_SEARCH_PAGE_SIZE) break;
      await yieldToEventLoop();
    }

    // maxInputs bounds memory indexing work per search. The query is a
    // separate required endpoint input, and the historical per-request cap
    // remains 24 even if a config asks for a larger value.
    const totalInputBound = Number.isInteger(Number(li.embeddings?.maxInputs))
      && Number(li.embeddings.maxInputs) > 0
      ? Number(li.embeddings.maxInputs)
      : 24;
    const memoryInputBudget = Math.max(1, Math.min(totalInputBound, 24));
    const cacheVectors = new Map();
    const readCached = (row) => {
      const key = cacheKey(row.content);
      const metadataMatches = row.content_hash === key.contentHash
        && row.provider === key.provider
        && row.model === key.model
        && Number(row.dimensions) === Number(key.dimensions);
      const vector = metadataMatches ? parseCachedVector(row.vector, dimensions) : null;
      cacheVectors.set(row.id, vector);
      return vector;
    };
    const missing = candidates.filter((row) => !readCached(row)).slice(0, memoryInputBudget);
    if (missing.length > 0) {
      checkBudget();
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
        cacheVectors.set(chunk[j].id, validVector(vector, dimensions) ? vector : null);
      }
    }

    const minSimilarity = Number.isFinite(Number(li.embeddings?.minSimilarity))
      ? Number(li.embeddings.minSimilarity)
      : 0;
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 6, SEMANTIC_SEARCH_MAX_LIMIT));
    const rows = [];
    const pushBounded = (entry) => {
      rows.push(entry);
      if (rows.length > boundedLimit) {
        let worst = 0;
        for (let i = 1; i < rows.length; i += 1) {
          if (rows[i].score < rows[worst].score) worst = i;
        }
        rows.splice(worst, 1);
      }
    };
    for (const row of candidates) {
      checkBudget();
      const vector = cacheVectors.has(row.id) ? cacheVectors.get(row.id) : readCached(row);
      if (!vector) {
        continue;
      }
      const score = cosineSimilarity(queryVec, vector);
      if (Number.isFinite(score) && score >= minSimilarity) {
        pushBounded({
          id: row.id,
          type: row.type,
          content: row.content,
          repository: row.repository ?? null,
          score,
        });
        partialRows = [...rows];
      }
    }

    rows.sort((a, b) => b.score - a.score);
    partialRows = rows;
    return {
      enabled: true,
      rows,
      diagnostics: {
        pageSize: SEMANTIC_SEARCH_PAGE_SIZE,
        totalCandidates: candidates.length,
        cached: [...cacheVectors.values()].filter(Boolean).length,
        indexed: missing.filter((row) => cacheVectors.get(row.id)).length,
        pending: candidates.filter((row) => !cacheVectors.get(row.id)).length,
        partialCoverage: candidates.some((row) => !cacheVectors.get(row.id)),
        fallback: false,
      },
    };
  } catch (error) {
    // Fail open: embedding problems must never break recall flows.
    if (partialRows.length > 0) {
      return {
        enabled: true,
        rows: partialRows,
        error: error instanceof Error ? error.message : String(error),
        diagnostics: { partialCoverage: true, fallback: true, deadline: true },
      };
    }
    return {
      enabled: false,
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    abort.cleanup();
  }
}

/** Index a bounded, fair slice of the embedding cache for maintenance. */
export async function indexMemoryEmbeddings({
  db,
  config = db.config,
  fetchImpl = globalThis.fetch,
  cursor = 0,
  maxMemories = 24,
  deadlineMs = SEMANTIC_SEARCH_DEFAULT_DEADLINE_MS,
} = {}) {
  const li = config?.localInference;
  if (!semanticSearchEnabled(config) || !db) {
    return { enabled: false, indexed: 0, pending: 0, failed: 0, total: 0, cursor: 0, reason: "embeddings_disabled" };
  }
  const provider = embeddingProvider(li);
  const model = String(li.embeddings.model).trim();
  const abort = createSearchAbortSignal(null, deadlineMs);
  try {
    db.ensureMemoryEmbeddingTable();
    const page = db.listSemanticMemoriesForEmbedding({
      includeEmbedding: true,
      limit: 256,
      offset: Math.max(0, Math.trunc(Number(cursor) || 0)),
    });
    if (page.length === 0) {
      return { enabled: true, indexed: 0, pending: 0, failed: 0, total: 0, cursor: 0, partialCoverage: false };
    }
    const invalid = page.filter((row) => {
      const key = {
        contentHash: embeddingContentHash(row.content),
        provider,
        model,
        dimensions: Number(row.dimensions),
      };
      return !parseCachedVector(
        row.content_hash === key.contentHash && row.provider === key.provider && row.model === key.model
          && Number(row.dimensions) > 0 ? row.vector : null,
        Number(row.dimensions) || null,
      );
    }).slice(0, Math.max(1, Math.min(24, Math.trunc(Number(maxMemories) || 24))));
    if (invalid.length === 0) {
      return { enabled: true, indexed: 0, pending: page.length === 256 ? 1 : 0, failed: 0, total: page.length, cursor: page.length === 256 ? Number(cursor) + page.length : 0, partialCoverage: page.length === 256 };
    }
    const resultVectors = await requestLocalInferenceEmbeddings({
      config: { ...li, model },
      input: invalid.map((row) => row.content),
      fetchImpl,
      signal: abort.signal,
      preserveInvalid: true,
    });
    let indexed = 0;
    let failed = 0;
    for (let i = 0; i < invalid.length; i += 1) {
      const vector = validVector(resultVectors[i]) ? resultVectors[i] : [];
      db.setMemoryEmbedding(invalid[i].id, vector, {
        contentHash: embeddingContentHash(invalid[i].content),
        provider,
        model,
        dimensions: vector.length,
      });
      if (vector.length > 0) indexed += 1;
      else failed += 1;
    }
    return { enabled: true, indexed, pending: Math.max(0, page.length - invalid.length), failed, total: page.length, cursor: page.length === 256 ? Number(cursor) + page.length : 0, partialCoverage: page.length === 256 || failed > 0 };
  } catch (error) {
    return { enabled: true, indexed: 0, pending: 0, failed: 1, total: 0, cursor: Number(cursor) || 0, partialCoverage: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    abort.cleanup();
  }
}
