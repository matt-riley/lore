import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { assembleRecall } from "../../lib/context/recall-assembler.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

const DB_SOURCE = readFileSync(new URL("../../lib/db/db.mjs", import.meta.url), "utf8");

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("assembleRecall", () => {
  test("injects only current extractor rejection policies as standing directives", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: { memoryOperations: true, directives: true },
      },
    });
    try {
      const insert = (id, content, repository, metadata, expiresAt) => db.insertSemanticMemory({
        id,
        type: "rejected_approach",
        content,
        scope: "repo",
        repository,
        metadata,
        expiresAt,
        confidence: 1,
        tags: ["rejected", "user"],
      });
      insert("standing-rejection", "Never expose credentials in examples.", "fixture-repo", { source: "rule_extractor", confidenceBasis: "explicit_rejection_sentence" });
      insert("ordinary-rejection", "The old implementation failed during a timeout.", "fixture-repo", { source: "rule_extractor", confidenceBasis: "bug_report" });
      insert("expired-rejection", "Never retain expired tokens.", "fixture-repo", { source: "rule_extractor", confidenceBasis: "explicit_rejection_sentence" }, "2000-01-01T00:00:00.000Z");
      insert("foreign-rejection", "Never expose beta credentials.", "other-repo", { source: "rule_extractor", confidenceBasis: "explicit_rejection_sentence" });
      const result = await assembleRecall({
        db,
        prompt: "What general guidance applies?",
        repository: "fixture-repo",
        config,
      });
      const directives = result.trace.lookups.directives;
      assert.deepEqual(directives.includedRows.map((row) => row.id), ["standing-rejection"]);
      assert.match(result.text, /Never expose credentials/);
      assert.doesNotMatch(result.text, /old implementation|expired tokens|beta credentials/);
    } finally {
      cleanup();
    }
  });

  test("filters rejection provenance before the standing-policy limit", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { enabled: true, rollout: { memoryOperations: true, directives: true } },
    });
    try {
      db.insertSemanticMemory({
        id: "older-standing-rejection",
        type: "rejected_approach",
        content: "Never expose the production signing key.",
        scope: "repo",
        repository: "fixture-repo",
        metadata: { source: "rule_extractor", confidenceBasis: "explicit_rejection_sentence" },
        confidence: 1,
        tags: ["rejected", "user"],
      });
      for (let index = 0; index < 70; index += 1) {
        db.insertSemanticMemory({
          id: `recent-ordinary-rejection-${index}`,
          type: "rejected_approach",
          content: `Observed timeout complaint ${index}.`,
          scope: "repo",
          repository: "fixture-repo",
          metadata: { source: "rule_extractor", confidenceBasis: "bug_report" },
          confidence: 1,
          tags: ["rejected", "user"],
        });
      }
      db.db.prepare("UPDATE semantic_memory SET updated_at = ? WHERE id LIKE 'recent-ordinary-rejection-%'").run("2099-01-01T00:00:00.000Z");
      const result = await assembleRecall({
        db,
        prompt: "What general guidance applies?",
        repository: "fixture-repo",
        config,
      });
      assert.ok(result.trace.lookups.directives.includedRows.some((row) => row.id === "older-standing-rejection"));
      assert.match(result.text, /Never expose the production signing key/);
      assert.doesNotMatch(result.text, /Observed timeout complaint/);
    } finally {
      cleanup();
    }
  });

  test("budget filtering removes dropped directives from included trace rows", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        budgets: { total: 180 },
        rollout: { memoryOperations: true, directives: true },
      },
    });
    try {
      for (let index = 1; index <= 3; index += 1) {
        db.insertSemanticMemory({
          id: `budget-directive-${index}`,
          type: "directive",
          content: `Directive ${index} ${"long policy text ".repeat(20)}`,
          scope: "repo",
          repository: "fixture-repo",
          confidence: 1,
          tags: ["directive"],
        });
      }
      const result = await assembleRecall({
        db,
        prompt: "What policies apply?",
        repository: "fixture-repo",
        config,
      });
      const directives = result.trace.lookups.directives;
      assert.equal(directives.rows.length, 3);
      assert.equal(directives.includedRows.length, 1);
      assert.equal((result.text.match(/Directive \d/gu) ?? []).length, 1);
      assert.match(directives.includedRows[0].content, /Directive [123]/);
      assert.match(result.text, new RegExp(directives.includedRows[0].content.slice(0, 12)));
    } finally {
      cleanup();
    }
  });

  test("LoreDb no longer renders Relevant Prior Work markdown", () => {
    assert.equal(DB_SOURCE.includes("## Relevant Prior Work"), false);
    assert.match(DB_SOURCE, /collectPromptContext\(/);
  });

  test("embeddings-off golden: lexical recall has no Semantic Matches section", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
        },
      },
    });
    try {
      db.insertSemanticMemory({
        id: "embeddings-off-decision",
        type: "decision",
        content: "Use PostgreSQL for concurrent writers.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["decision"],
      });
      const result = await assembleRecall({
        db,
        prompt: "Which database did we choose for concurrent writers?",
        repository: "fixture-repo",
        config,
      });
      assert.match(result.text, /PostgreSQL/);
      assert.equal(result.text.includes("## Semantic Matches"), false);
      assert.equal(result.trace?.lookups?.semantic, undefined);
      assert.equal(result.localInference?.queryExpansion?.requested, false);
    } finally {
      cleanup();
    }
  });

  test("expansion-on golden: query expansion is used and fails open", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          model: "local-chat-model",
          queryExpansion: {
            enabled: true,
            maxTerms: 4,
          },
          embeddings: {
            enabled: false,
            model: "",
          },
        },
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
        },
      },
    });
    try {
      db.insertSemanticMemory({
        id: "expansion-on-blocker",
        type: "blocker",
        content: "GitHub Actions deployment checks were repeatedly failing.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["ci"],
      });

      const expanded = await assembleRecall({
        db,
        prompt: "What deployment trouble kept recurring?",
        repository: "fixture-repo",
        config,
        fetchImpl: async () => jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                terms: ["github actions", "deployment checks"],
              }),
            },
          }],
        }),
      });
      assert.equal(expanded.localInference.queryExpansion.requested, true);
      assert.equal(expanded.localInference.queryExpansion.used, true);
      assert.match(expanded.text, /GitHub Actions deployment checks/);
      assert.equal(expanded.text.includes("## Semantic Matches"), false);

      config.localInference.enabled = false;
      const failOpen = await assembleRecall({
        db,
        prompt: "What deployment trouble kept recurring?",
        repository: "fixture-repo",
        config,
        fetchImpl: async () => {
          throw new Error("unexpected model request");
        },
      });
      assert.equal(failOpen.localInference.queryExpansion.requested, true);
      assert.equal(failOpen.localInference.queryExpansion.used, false);
      assert.equal(failOpen.localInference.queryExpansion.error, "provider disabled");
      assert.match(failOpen.text, /GitHub Actions deployment checks/);
    } finally {
      cleanup();
    }
  });

  test("collectPromptContext returns rows without rendering markdown headings", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: { memoryOperations: true, temporalQueryNormalization: true },
      },
    });
    try {
      db.upsertEpisodeDigest({
        id: "ep-row-only",
        sessionId: "session-row-only",
        repository: "fixture-repo",
        summary: "Refactored the pipeline.",
        actions: ["refactored"],
        decisions: [],
        learnings: [],
        filesChanged: [],
        refs: [],
        significance: 5,
        themes: ["refactor"],
        openItems: [],
        dateKey: "2024-03-26",
        createdAt: "2024-03-26T09:00:00.000Z",
      });
      const collected = db.collectPromptContext({
        prompt: "what did we do yesterday",
        repository: "fixture-repo",
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });
      assert.equal(collected.text, undefined);
      assert.ok(Array.isArray(collected.temporalCtx.episodes));
      assert.equal(JSON.stringify(collected.semanticCtx).includes("## Relevant Prior Work"), false);
      const rendered = await assembleRecall({
        db,
        prompt: "what did we do yesterday",
        repository: "fixture-repo",
        config: db.config,
        phases: {
          procedural: false,
          proposals: false,
          onboarding: false,
          directives: false,
          workstream: false,
        },
        promptNeed: collected.need,
      });
      assert.equal(typeof rendered.text, "string");
    } finally {
      cleanup();
    }
  });
});
