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
import { isSemanticMemoryRowEligible } from "../db/db-retrieval-policy.mjs";

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
  "decision",
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

/** Return a cached vector only when every cache identity field is current. */
export function validatedCachedEmbeddingVector(row, { content, provider, model, dimensions } = {}) {
  if (!row || row.content_hash !== embeddingContentHash(content)
    || row.provider !== provider
    || row.model !== model
    || Number(row.dimensions) !== Number(dimensions)) {
    return null;
  }
  return parseCachedVector(row.vector, dimensions);
}

export function embeddingProviderIdentity(config) {
  return embeddingProvider(config);
}

function parseMetadata(value) {
  if (typeof value !== "string") return value && typeof value === "object" ? value : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function pushTopKHeap(heap, entry, limit) {
  const less = (left, right) => left.score < right.score;
  if (heap.length >= limit && entry.score <= heap[0].score) return;
  const replacingRoot = heap.length >= limit;
  if (replacingRoot) {
    heap[0] = entry;
  } else {
    heap.push(entry);
  }
  let index = heap.length - 1;
  if (!replacingRoot && index > 0) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!less(heap[index], heap[parent])) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
    return;
  }
  let cursor = 0;
  while (true) {
    const left = cursor * 2 + 1;
    const right = left + 1;
    let smallest = cursor;
    if (left < heap.length && less(heap[left], heap[smallest])) smallest = left;
    if (right < heap.length && less(heap[right], heap[smallest])) smallest = right;
    if (smallest === cursor) break;
    [heap[cursor], heap[smallest]] = [heap[smallest], heap[cursor]];
    cursor = smallest;
  }
}

function heapToSortedRows(heap) {
  return [...heap].sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)));
}

function embeddingPageCursor(row) {
  return {
    memoryRowid: row.memory_rowid,
  };
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
  transferableFallback = false,
  scopes = [],
  types = SEMANTIC_SEARCH_TYPES,
  limit = 6,
  fetchImpl = globalThis.fetch,
  config = db.config,
  signal,
  deadlineMs,
  now = new Date(),
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
      const error = new Error("semantic search deadline exceeded");
      error.name = "SemanticDeadlineError";
      throw error;
    }
  };
  const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
  let partialRows = [];
  let scannedCandidates = 0;
  let pagesScanned = 0;
  const pendingEmbeddings = [];
  const persistPendingEmbeddings = () => {
    for (const { row, vector } of pendingEmbeddings) {
      try {
        db.setMemoryEmbedding(row.id, vector, {
          contentHash: embeddingContentHash(row.content),
          provider,
          model,
          dimensions: vector.length,
        });
      } catch {
        // Preserve the original retrieval/provider error. A cache write is
        // an optimization and must not turn fail-open recall into a failure.
      }
    }
    pendingEmbeddings.length = 0;
  };

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

    let totalCandidates = 0;
    let cachedCount = 0;
    let indexedCount = 0;
    let pendingCount = 0;
    let deferredMissing = false;
    let indexingRemaining = Math.max(1, Math.min(Number(li.embeddings?.maxInputs) || 24, 24));
    let rows = [];
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 6, SEMANTIC_SEARCH_MAX_LIMIT));
    const pushBounded = (entry) => pushTopKHeap(rows, entry, boundedLimit);
    const minSimilarity = Number.isFinite(Number(li.embeddings?.minSimilarity))
      ? Number(li.embeddings.minSimilarity)
      : 0;
    for (const embeddingState of ["missing", "cached"]) {
      let after = null;
      for (;;) {
        checkBudget();
        const page = db.listSemanticMemoriesForEmbedding({
          types,
          repository,
          includeOtherRepositories,
          transferableFallback,
          embeddingState,
          ...(scopes.length > 0 ? { scopes } : {}),
          includeEmbedding: true,
          limit: SEMANTIC_SEARCH_PAGE_SIZE,
          after,
          now,
        });
        totalCandidates += page.length;
        scannedCandidates += page.length;
        pagesScanned += 1;
        const eligiblePage = page.filter((row) => isSemanticMemoryRowEligible(row, {
          repository,
          includeOtherRepositories,
          now,
        }).eligible);
        const missing = [];
        for (const row of eligiblePage) {
          checkBudget();
          const vector = validatedCachedEmbeddingVector(row, {
            content: row.content,
            provider,
            model,
            dimensions,
          });
          if (vector) {
            cachedCount += 1;
            const score = cosineSimilarity(queryVec, vector);
            if (Number.isFinite(score) && score >= minSimilarity) {
              pushBounded({ id: row.id, type: row.type, content: row.content, scope: row.scope,
                repository: row.repository ?? null, expiresAt: row.expires_at ?? null,
                metadata: parseMetadata(row.metadata_json), score });
              partialRows = [...rows];
            }
          } else if (indexingRemaining > 0) {
            missing.push(row);
            indexingRemaining -= 1;
          } else {
            pendingCount += 1;
            deferredMissing = true;
          }
        }
        if (missing.length > 0) {
          checkBudget();
          const vectors = await requestLocalInferenceEmbeddings({
            config: embedConfig,
            input: missing.map((row) => row.content),
            fetchImpl,
            signal: abort.signal,
            preserveInvalid: true,
          });
          for (let j = 0; j < missing.length; j++) {
            checkBudget();
            const vector = validVector(vectors[j], dimensions) ? vectors[j] : [];
            pendingEmbeddings.push({ row: missing[j], vector });
            if (vector.length > 0) {
              indexedCount += 1;
              const score = cosineSimilarity(queryVec, vector);
              if (Number.isFinite(score) && score >= minSimilarity) {
                pushBounded({ id: missing[j].id, type: missing[j].type, content: missing[j].content,
                  scope: missing[j].scope, repository: missing[j].repository ?? null,
                  expiresAt: missing[j].expires_at ?? null, metadata: parseMetadata(missing[j].metadata_json), score });
                partialRows = [...rows];
              }
            } else {
              pendingCount += 1;
            }
          }
        }
        if (page.length < SEMANTIC_SEARCH_PAGE_SIZE) break;
        after = embeddingPageCursor(page.at(-1));
        await yieldToEventLoop();
      }
    }

    rows = heapToSortedRows(rows);
    persistPendingEmbeddings();
    partialRows = rows;
    return {
      enabled: true,
      rows,
      diagnostics: {
        pageSize: SEMANTIC_SEARCH_PAGE_SIZE,
        totalCandidates,
        cached: cachedCount,
        indexed: indexedCount,
        pending: pendingCount,
        partialCoverage: pendingCount > 0 || deferredMissing,
        coverage: { scannedCandidates: totalCandidates, complete: true },
        fallback: false,
      },
    };
  } catch (error) {
    // Fail open: embedding problems must never break recall flows.
    persistPendingEmbeddings();
    const errorCategory = error?.name === "SemanticDeadlineError"
      ? "deadline"
      : error?.name === "AbortError" || signal?.aborted
      ? "cancelled"
      : error?.message?.includes("embeddings") || error?.message?.includes("embedding")
      ? "provider"
      : "retrieval";
    if (partialRows.length > 0) {
      partialRows = heapToSortedRows(partialRows);
      return {
        enabled: true,
        rows: partialRows,
        error: error instanceof Error ? error.message : String(error),
        diagnostics: { partialCoverage: true, fallback: true, errorCategory, deadline: errorCategory === "deadline", scannedCandidates, pagesScanned, coverage: { scannedCandidates, complete: false }, sorted: true },
      };
    }
    return {
      enabled: false,
      rows: [],
      error: error instanceof Error ? error.message : String(error),
      diagnostics: { partialCoverage: false, fallback: true, errorCategory, deadline: errorCategory === "deadline", scannedCandidates, pagesScanned, coverage: { scannedCandidates, complete: false } },
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
  const li = config?.localInference ?? config;
  if (!semanticSearchEnabled(config) || !db) {
    return { enabled: false, indexed: 0, pending: 0, failed: 0, total: 0, cursor: 0, reason: "embeddings_disabled" };
  }
  const provider = embeddingProvider(li);
  const model = String(li.embeddings.model).trim();
  const expectedDimensions = Number.isInteger(Number(li.embeddings?.dimensions))
    && Number(li.embeddings.dimensions) > 0 ? Number(li.embeddings.dimensions) : null;
  const abort = createSearchAbortSignal(null, deadlineMs);
  try {
    db.ensureMemoryEmbeddingTable();
    const page = db.listSemanticMemoriesForEmbedding({
      includeEmbedding: true,
      includeOtherRepositories: true,
      stableOrder: true,
      limit: 256,
      offset: Math.max(0, Math.trunc(Number(cursor) || 0)),
    });
    const total = typeof db.countSemanticMemoriesForEmbedding === "function"
      ? db.countSemanticMemoriesForEmbedding({ includeOtherRepositories: true })
      : page.length;
    if (page.length === 0) {
      return { enabled: true, indexed: 0, pending: 0, failed: 0, total, scanned: 0, cursor: 0, partialCoverage: false };
    }
    const eligiblePage = page.filter((row) => isSemanticMemoryRowEligible(row, {
      includeOtherRepositories: true,
    }).eligible);
    const invalidRows = eligiblePage.filter((row) => {
      return !validatedCachedEmbeddingVector(row, {
        content: row.content,
        provider,
        model,
        dimensions: expectedDimensions ?? (Number(row.dimensions) || null),
      });
    });
    const invalid = invalidRows.slice(0, Math.max(1, Math.min(24, Math.trunc(Number(maxMemories) || 24))));
    const processed = invalid.length > 0 ? page.findIndex((row) => row.id === invalid.at(-1).id) + 1 : page.length;
    const advancedCursor = Math.max(0, Math.trunc(Number(cursor) || 0)) + processed;
    const nextCursor = advancedCursor >= total ? 0 : advancedCursor;
    const partialPageCoverage = Number(cursor) > 0 || total > page.length;
    if (invalid.length === 0) {
      return { enabled: true, indexed: 0, pending: 0, pendingScope: "scanned_page", failed: 0, total, scanned: page.length, cursor: nextCursor, partialCoverage: partialPageCoverage };
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
      const vector = validVector(resultVectors[i], expectedDimensions) ? resultVectors[i] : [];
      db.setMemoryEmbedding(invalid[i].id, vector, {
        contentHash: embeddingContentHash(invalid[i].content),
        provider,
        model,
        dimensions: vector.length,
      });
      if (vector.length > 0) indexed += 1;
      else failed += 1;
    }
    return { enabled: true, indexed, pending: invalidRows.length - indexed, pendingScope: "scanned_page", failed, total, scanned: page.length, cursor: nextCursor, partialCoverage: partialPageCoverage || invalidRows.length > indexed };
  } catch (error) {
    return { enabled: true, indexed: 0, pending: 0, failed: 1, total: 0, cursor: (Number(cursor) || 0) + 1, partialCoverage: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    abort.cleanup();
  }
}
