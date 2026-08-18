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

/**
 * Cosine similarity between two equal-length vectors. Returns 0 for empty or
 * length-mismatched inputs so malformed cached vectors rank as no match.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
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
}) {
  const li = config?.localInference;
  if (li?.enabled !== true || li?.embeddings?.enabled !== true || !semanticSearchEnabled(li)) {
    return { enabled: false, rows: [] };
  }
  // Embeddings calls use the embeddings model, not the chat model.
  const embedConfig = { ...li, model: li.embeddings.model };

  try {
    db.ensureMemoryEmbeddingTable();

    const [queryVec] = await requestLocalInferenceEmbeddings({
      config: embedConfig,
      input: [String(query ?? "")],
      fetchImpl,
    });
    if (!Array.isArray(queryVec)) {
      throw new Error("local embeddings returned no query vector");
    }

    const candidates = db.listSemanticMemoriesForEmbedding({ types, repository });

    // Lazily embed memories that have no cached vector yet, in bounded
    // batches so one slow endpoint call never blocks everything.
    const missing = candidates.filter((row) => !db.getMemoryEmbedding(row.id));
    const batchSize = Math.max(1, Math.min(Number(li.embeddings?.maxInputs ?? 24), 24));
    for (let i = 0; i < missing.length; i += batchSize) {
      const chunk = missing.slice(i, i + batchSize);
      const vectors = await requestLocalInferenceEmbeddings({
        config: embedConfig,
        input: chunk.map((row) => row.content),
        fetchImpl,
      });
      for (let j = 0; j < chunk.length; j++) {
        if (Array.isArray(vectors[j])) {
          db.setMemoryEmbedding(chunk[j].id, vectors[j]);
        }
      }
    }

    const rows = [];
    for (const row of candidates) {
      const stored = db.getMemoryEmbedding(row.id);
      if (!stored) {
        continue;
      }
      try {
        rows.push({
          id: row.id,
          type: row.type,
          content: row.content,
          repository: row.repository ?? null,
          score: cosineSimilarity(queryVec, JSON.parse(stored)),
        });
      } catch {
        // unreadable cached vector — skip
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
  }
}
