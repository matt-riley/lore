#!/usr/bin/env node
// v1 in-process lexical baseline over the same synthetic corpus, using the
// existing v1 database and search code. Emits a JSON report on stdout.
//
//   node daemon/tests/v1-lexical-baseline.mjs

import { FTS5_AVAILABLE, freshDb } from "../../tests/helpers/fixture-db.mjs";
import { freshInstallConfig } from "../../tests/helpers/fixture-config.mjs";
import { createTempHome } from "../../tests/helpers/temp-home.mjs";
import { generateSyntheticCorpus } from "./harness.mjs";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
}
const COUNT = option("--count", 10_000);
const QUERY_COUNT = option("--queries", 200);

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: +sorted[0].toFixed(3),
    p50Ms: +percentile(sorted, 0.5).toFixed(3),
    p95Ms: +percentile(sorted, 0.95).toFixed(3),
    p99Ms: +percentile(sorted, 0.99).toFixed(3),
    maxMs: +sorted.at(-1).toFixed(3),
  };
}

async function main() {
  if (!FTS5_AVAILABLE) {
    console.log(JSON.stringify({ mode: "v1-lexical-in-process", skipped: "FTS5 unavailable" }));
    return;
  }
  const { home, cleanup } = createTempHome();
  try {
    const db = freshDb(freshInstallConfig(home));
    const corpus = generateSyntheticCorpus(COUNT);
    const now = new Date().toISOString();
    const insert = db.db.prepare(
      "INSERT INTO semantic_memory (id, type, content, confidence, scope, repository, tags, created_at, updated_at) VALUES (?, 'note', ?, 1.0, 'global', NULL, '', ?, ?)",
    );
    const loadStart = process.hrtime.bigint();
    db.db.exec("BEGIN");
    corpus.memories.forEach((memory, index) => {
      insert.run(`v1-memory-${index}`, memory.content, now, now);
    });
    db.db.exec("COMMIT");
    const loadSeconds = Number(process.hrtime.bigint() - loadStart) / 1e9;

    for (let index = 0; index < 20; index += 1) {
      db.searchSemantic({
        query: corpus.queries[index % corpus.queries.length],
        repository: null,
        limit: 6,
      });
    }

    const latencies = [];
    for (let index = 0; index < QUERY_COUNT; index += 1) {
      const query = corpus.queries[index % corpus.queries.length];
      const start = process.hrtime.bigint();
      db.searchSemantic({ query, repository: null, limit: 6 });
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
    }

    console.log(
      JSON.stringify(
        {
          mode: "v1-lexical-in-process",
          generatedAt: new Date().toISOString(),
          platform: { os: process.platform, arch: process.arch, node: process.version },
          corpus: { memories: COUNT, queries: QUERY_COUNT },
          loadSeconds: +loadSeconds.toFixed(2),
          recallMs: summarize(latencies),
        },
        null,
        2,
      ),
    );
    db.close();
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
