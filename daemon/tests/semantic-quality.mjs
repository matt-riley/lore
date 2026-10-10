#!/usr/bin/env node
// Semantic quality runner.
//
//   node daemon/tests/semantic-quality.mjs --mode v2 --split held-out --threshold 0.4
//   node daemon/tests/semantic-quality.mjs --mode v1-semantic --split held-out --threshold 0.4
//   node daemon/tests/semantic-quality.mjs --mode v1-lexical --split held-out
//
// Emits a JSON report; --report PATH also writes it.

import { readFileSync, writeFileSync } from "node:fs";

import { semanticSearch } from "../../lib/memory/semantic-search.mjs";
import { freshDb } from "../../tests/helpers/fixture-db.mjs";
import { freshInstallConfig } from "../../tests/helpers/fixture-config.mjs";
import { createTempHome } from "../../tests/helpers/temp-home.mjs";
import { parseOk, forget, recall } from "../clients/js/status-client.mjs";
import {
  loadCorpus,
  localEmbeddingConfig,
  startDaemon,
  waitForCoverage,
  waitForLiveStatus,
} from "./harness.mjs";
import { CORPUS_PATH, corpusHash, splitFamilies } from "./semantic-corpus.mjs";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const MODE = option("--mode", "v2");
const SPLIT = option("--split", "held-out");
const THRESHOLD = Number(option("--threshold", "0.35"));
const REPORT = option("--report", null);
const LIMIT = Number(option("--limit", "6"));

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
const families = splitFamilies(corpus, SPLIT);

function newAccumulator() {
  return {
    positive: 0,
    hits: 0,
    reciprocal: 0,
    returned: 0,
    nonGold: 0,
    canaryHits: 0,
    negativeQueries: 0,
    negativeReturned: 0,
    fallbackCounts: {},
  };
}

function addPositive(accumulator, records, goldId, canaryId) {
  accumulator.positive += 1;
  accumulator.returned += records.length;
  const ids = records.map((record) => record.id);
  const rank = ids.indexOf(goldId);
  if (rank >= 0) {
    accumulator.hits += 1;
    accumulator.reciprocal += 1 / (rank + 1);
  }
  accumulator.nonGold += ids.filter((id) => id !== goldId).length;
  if (ids.includes(canaryId)) {
    accumulator.canaryHits += 1;
  }
}

function addNegative(accumulator, records) {
  accumulator.negativeQueries += 1;
  accumulator.negativeReturned += records.length;
  accumulator.returned += records.length;
  accumulator.nonGold += records.length;
}

function summarize(accumulator) {
  return {
    positiveQueries: accumulator.positive,
    recallAt6: accumulator.positive === 0 ? 0 : accumulator.hits / accumulator.positive,
    mrrAt6: accumulator.positive === 0 ? 0 : accumulator.reciprocal / accumulator.positive,
    irrelevantRate:
      accumulator.returned === 0 ? 0 : accumulator.nonGold / accumulator.returned,
    canaryHits: accumulator.canaryHits,
    negativeQueries: accumulator.negativeQueries,
    negativeReturned: accumulator.negativeReturned,
    fallbackCounts: accumulator.fallbackCounts,
  };
}

async function runV2() {
  const embedding = { ...localEmbeddingConfig(), minSimilarity: THRESHOLD };
  const daemon = startDaemon({ embedding });
  try {
    const status = await waitForLiveStatus(daemon.socket);
    const storeId = status.storeId;
    const memories = families.map((family) => ({
      type: "decision",
      content: family.memory,
      scope: "global",
    }));
    memories.push({ type: "decision", content: corpus.canary, scope: "global" });
    const ids = await loadCorpus(
      daemon.socket,
      { seed: corpus.seed, memories },
      { expectedStoreId: storeId },
    );
    const byFamily = new Map(families.map((family, index) => [family.id, ids[index]]));
    const canaryId = ids[ids.length - 1];
    // Deletion safety: a forgotten canary must not return through either path,
    // including its already-stored vector.
    parseOk(
      await forget(
        daemon.socket,
        { idempotencyKey: "canary-forget", memoryId: canaryId, reason: "safety canary" },
        { expectedStoreId: storeId },
      ),
    );
    const covered = await waitForCoverage(daemon.socket);
    const accumulator = newAccumulator();
    for (const family of families) {
      for (const query of family.queries) {
        const value = parseOk(
          await recall(daemon.socket, { query, limit: LIMIT }, { expectedStoreId: storeId }),
        );
        addPositive(accumulator, value.result.records, byFamily.get(family.id), canaryId);
        const reason = value.result.diagnostics.fallbackReason;
        accumulator.fallbackCounts[reason] = (accumulator.fallbackCounts[reason] ?? 0) + 1;
      }
    }
    for (const query of corpus.negatives) {
      const value = parseOk(
        await recall(daemon.socket, { query, limit: LIMIT }, { expectedStoreId: storeId }),
      );
      addNegative(accumulator, value.result.records);
    }
    return {
      mode: "v2",
      coverage: covered.result.embedding,
      ...summarize(accumulator),
    };
  } finally {
    await daemon.stop();
    daemon.cleanup();
  }
}

async function runV1(mode) {
  const embedding = { ...localEmbeddingConfig(), minSimilarity: THRESHOLD };
  const { home, cleanup } = createTempHome();
  try {
    const config = freshInstallConfig(home);
    config.localInference = {
      enabled: true,
      baseUrl: embedding.endpoint,
      embeddings: {
        enabled: true,
        model: embedding.model,
        minSimilarity: THRESHOLD,
      },
    };
    const db = freshDb(config);
    const now = new Date().toISOString();
    const insert = db.db.prepare(
      "INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at) VALUES (?, 'decision', ?, 1.0, 'global', NULL, '', ?, ?)",
    );
    const byFamily = new Map();
    db.db.exec("BEGIN");
    for (const family of families) {
      const id = `v1-${family.id}`;
      byFamily.set(family.id, id);
      insert.run(id, family.memory, now, now);
    }
    const canaryId = "v1-canary";
    // The v1 comparison does not insert the canary: deletion safety is proven
    // on the v2 path where Forget actually runs.
    db.db.exec("COMMIT");

    const search = async (query) => {
      if (mode === "v1-semantic") {
        const outcome = await semanticSearch({
          db,
          query,
          repository: null,
          limit: LIMIT,
          config: config.localInference,
        });
        return outcome.rows ?? [];
      }
      return db.searchSemantic({ query, repository: null, limit: LIMIT });
    };

    // Precompute memory vectors; query vectors stay first-seen.
    await search("warmup precompute");

    const accumulator = newAccumulator();
    for (const family of families) {
      for (const query of family.queries) {
        addPositive(accumulator, await search(query), byFamily.get(family.id), canaryId);
      }
    }
    for (const query of corpus.negatives) {
      addNegative(accumulator, await search(query));
    }
    db.close();
    return { mode, ...summarize(accumulator) };
  } finally {
    cleanup();
  }
}

async function main() {
  const base = {
    split: SPLIT,
    threshold: MODE === "v1-lexical" ? null : THRESHOLD,
    corpusHash: corpusHash(),
    families: families.length,
  };
  const result =
    MODE === "v2"
      ? await runV2()
      : MODE === "v1-semantic"
        ? await runV1("v1-semantic")
        : await runV1("v1-lexical");
  const report = { ...base, ...result };
  console.log(JSON.stringify(report, null, 2));
  if (REPORT) {
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
