// Curated lexical quality gate: recall@6, MRR@6 and irrelevant-context rate
// over the shared fixture. Runs against a real daemon.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { parseOk, recall } from "../clients/js/status-client.mjs";
import { REPO_ROOT, loadCorpus, readJson, startDaemon, waitForLiveStatus } from "./harness.mjs";

test("curated lexical corpus meets recall@6 and MRR@6 floors", { skip: !process.env.LORED_BIN }, async () => {
  const corpus = readJson(path.join(REPO_ROOT, "tests/v2/fixtures/lexical-corpus.json"));
  const daemon = startDaemon();
  try {
    const status = await waitForLiveStatus(daemon.socket);
    const ids = await loadCorpus(daemon.socket, corpus, { expectedStoreId: status.storeId });
    const byKey = new Map(corpus.memories.map((memory, index) => [memory.key, ids[index]]));

    let hits = 0;
    let reciprocalTotal = 0;
    let nonGold = 0;
    let returned = 0;
    for (const testCase of corpus.queries) {
      const result = parseOk(
        await recall(
          daemon.socket,
          { query: testCase.query, limit: 6 },
          { expectedStoreId: status.storeId },
        ),
      );
      const returnedIds = result.result.records.map((record) => record.id);
      returned += returnedIds.length;
      const gold = testCase.relevant.map((key) => byKey.get(key));
      const rank = returnedIds.findIndex((id) => gold.includes(id));
      if (rank >= 0) {
        hits += 1;
        reciprocalTotal += 1 / (rank + 1);
      }
      nonGold += returnedIds.filter((id) => !gold.includes(id)).length;
    }

    const recallAt6 = hits / corpus.queries.length;
    const mrrAt6 = reciprocalTotal / corpus.queries.length;
    const irrelevantRate = returned === 0 ? 0 : nonGold / returned;
    console.log(JSON.stringify({ recallAt6, mrrAt6, irrelevantRate, queries: corpus.queries.length }));
    assert.equal(recallAt6, 1, "every curated query finds its gold memory in the top six");
    assert.ok(mrrAt6 >= 0.7, `MRR@6 ${mrrAt6} is below the floor`);
    assert.ok(irrelevantRate <= 0.5, `irrelevant rate ${irrelevantRate} is above the floor`);
  } finally {
    await daemon.stop();
    daemon.cleanup();
  }
});
