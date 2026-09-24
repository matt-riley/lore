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
  test("does not promote extractor rejection policies into standing directives", { skip: SKIP_NO_FTS5 }, async () => {
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
      assert.deepEqual(directives.includedRows, []);
      assert.doesNotMatch(result.text, /Never expose credentials|old implementation|expired tokens|beta credentials/);
    } finally {
      cleanup();
    }
  });

  test("does not inject an auto-global directive without explicit cross-project scope", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: { memoryOperations: true, directives: true },
      },
    });
    try {
      db.insertSemanticMemory({
        id: "leaked-video-directive",
        type: "directive",
        content: "The output should be saved in @copilot/assets/video/.",
        scope: "global",
        metadata: { source: "rule_extractor", confidenceBasis: "standing_policy_sentence" },
        confidence: 0.78,
        tags: ["directive", "policy", "user"],
      });
      db.insertSemanticMemory({
        id: "explicit-global-directive",
        type: "directive",
        content: "For any project, always use plain ESM.",
        scope: "global",
        metadata: { source: "rule_extractor", confidenceBasis: "standing_policy_sentence" },
        confidence: 0.78,
        tags: ["directive", "policy", "user"],
      });

      const result = await assembleRecall({
        db,
        prompt: "Fix the config loader",
        repository: "fixture-repo",
        config,
      });

      assert.doesNotMatch(result.text, /copilot\/assets\/video/);
      assert.match(result.text, /For any project, always use plain ESM/);
      assert.deepEqual(
        result.trace.lookups.directives.includedRows.map((row) => row.id),
        ["explicit-global-directive"],
      );
    } finally {
      cleanup();
    }
  });

  test("only prompt-relevant repo directives consume the standing-policy limit", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { enabled: true, rollout: { memoryOperations: true, directives: true } },
    });
    try {
      db.insertSemanticMemory({
        id: "relevant-repo-directive",
        type: "directive",
        content: "The production signing key must be protected.",
        scope: "repo",
        repository: "fixture-repo",
        metadata: { source: "rule_extractor", confidenceBasis: "standing_policy_sentence" },
        confidence: 1,
        tags: ["directive", "policy", "user"],
      });
      db.insertSemanticMemory({
        id: "unrelated-repo-directive",
        type: "directive",
        content: "The external editor should be neovim.",
        scope: "repo",
        repository: "fixture-repo",
        metadata: { source: "rule_extractor", confidenceBasis: "standing_policy_sentence" },
        confidence: 1,
        tags: ["directive", "policy", "user"],
      });
      db.insertSemanticMemory({
        id: "old-rejection",
        type: "rejected_approach",
        content: "Never expose the production signing key.",
        scope: "repo",
        repository: "fixture-repo",
        metadata: { source: "rule_extractor", confidenceBasis: "explicit_rejection_sentence" },
        confidence: 1,
        tags: ["rejected", "user"],
      });
      const result = await assembleRecall({
        db,
        prompt: "What protects the production signing key?",
        repository: "fixture-repo",
        config,
      });
      assert.deepEqual(
        result.trace.lookups.directives.includedRows.map((row) => row.id),
        ["relevant-repo-directive"],
      );
      assert.doesNotMatch(result.text, /external editor|old-rejection/);
    } finally {
      cleanup();
    }
  });

  test("scaffold-only overlap does not make a repo directive relevant", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { enabled: true, rollout: { memoryOperations: true, directives: true } },
    });
    try {
      db.insertSemanticMemory({
        id: "scaffold-overlap-directive",
        type: "directive",
        content: "The external editor should be neovim.",
        scope: "repo",
        repository: "fixture-repo",
        metadata: { source: "rule_extractor", confidenceBasis: "standing_policy_sentence" },
        confidence: 1,
        tags: ["directive", "policy", "user"],
      });
      const result = await assembleRecall({
        db,
        prompt: "OK so it should be fixed now",
        repository: "fixture-repo",
        config,
      });
      assert.deepEqual(result.trace.lookups.directives.includedRows, []);
      assert.doesNotMatch(result.text, /neovim/);
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
          metadata: { source: "memory_save" },
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

  test("vector fusion cannot re-admit global rows dropped by the relevance gate", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          baseUrl: "http://127.0.0.1:1/v1",
          model: "local-chat-model",
          embeddings: { enabled: true, model: "fake-embedding-model", maxInputs: 24, minSimilarity: 0 },
        },
        rollout: { memoryOperations: true, temporalQueryNormalization: true },
      },
    });
    try {
      db.insertSemanticMemory({
        id: "stale-global-review-request",
        type: "rejected_approach",
        content: "I would like you to review the go code in this project and tell me if there is anything which needs improving. Do not make any code changes",
        repository: null,
        scope: "global",
        confidence: 0.8,
      });
      db.insertSemanticMemory({
        id: "relevant-global-skills-rule",
        type: "rejected_approach",
        content: "Never install skills with the npx skills CLI.",
        repository: null,
        scope: "global",
        confidence: 0.9,
      });
      // Every text embeds identically, so every row is a perfect vector hit:
      // only the relevance gate can keep the stale row out.
      const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body);
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return jsonResponse({ data: inputs.map((_text, index) => ({ index, embedding: [1, 0, 0] })) });
      };
      const review = await assembleRecall({
        db,
        prompt: "I want you to do a full code review of this codebase and tell me what is good and bad",
        repository: "fixture-repo",
        config,
        fetchImpl,
      });
      assert.equal(review.text.includes("review the go code"), false);
      const filtered = review.trace?.lookups?.localMemories?.filtered ?? [];
      assert.ok(filtered.some((entry) => entry.stage === "vector_fusion" && entry.reason === "global_relevance_gate"));

      const skills = await assembleRecall({
        db,
        prompt: "should I install this with the npx skills CLI?",
        repository: "fixture-repo",
        config,
        fetchImpl,
      });
      assert.match(skills.text, /npx skills CLI/);
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

  test("global commitments need stronger evidence than generic task-request words", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { enabled: true, rollout: { memoryOperations: true } },
    });
    try {
      const insertGlobalRejection = (id, content) => db.insertSemanticMemory({
        id,
        type: "rejected_approach",
        content,
        scope: "global",
        confidence: 1,
        tags: ["rejected", "user"],
      });
      insertGlobalRejection("go-review", "I would like you to review the go code in this project and tell me if there is anything which needs improving or fixing. Do not make any code changes");
      insertGlobalRejection("git-diff-review", "Review `git diff --cached`, falling back to `git diff` if nothing is staged.");
      insertGlobalRejection("monitor-review", "Don't forget to monitor for review comments too");
      db.insertSemanticMemory({
        id: "repo-review-checklist",
        type: "rejected_approach",
        content: "This repo's review checklist requires running lint before merging.",
        scope: "repo",
        repository: "fixture-repo",
        confidence: 1,
        tags: ["rejected", "user"],
      });

      const prompt = "I want you to do a full code review of this codebase and tell me what is good, what is bad, what else could be added to it";
      const result = await assembleRecall({ db, prompt, repository: "fixture-repo", config });

      const localMemories = result.trace.lookups.localMemories;
      assert.deepEqual(localMemories.includedRows.map((row) => row.id), ["repo-review-checklist"]);
      assert.deepEqual(
        localMemories.filtered.map((entry) => entry.row.id).sort(),
        ["git-diff-review", "go-review", "monitor-review"],
      );
      assert.ok(localMemories.filtered.every((entry) => entry.reason === "global_relevance_gate"));
      assert.doesNotMatch(result.text, /review the go code|git diff --cached|monitor for review comments/);
      assert.match(result.text, /review checklist requires running lint/);
    } finally {
      cleanup();
    }
  });

  test("a global rejected approach with real term overlap still surfaces", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { enabled: true, rollout: { memoryOperations: true } },
    });
    try {
      db.insertSemanticMemory({
        id: "no-force-push",
        type: "rejected_approach",
        content: "Never force-push to shared branches.",
        scope: "global",
        confidence: 1,
        tags: ["rejected", "user"],
      });

      const result = await assembleRecall({
        db,
        prompt: "should I force push this branch to main?",
        repository: "fixture-repo",
        config,
      });

      assert.deepEqual(result.trace.lookups.localMemories.includedRows.map((row) => row.id), ["no-force-push"]);
      assert.deepEqual(result.trace.lookups.localMemories.filtered, []);
      assert.match(result.text, /Never force-push to shared branches/);
    } finally {
      cleanup();
    }
  });

  test("a repo-scoped memory matched on a single generic term keeps its current behaviour", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { enabled: true, rollout: { memoryOperations: true } },
    });
    try {
      db.insertSemanticMemory({
        id: "repo-code-style",
        type: "user_preference",
        content: "Keep two-space indentation across the codebase.",
        scope: "repo",
        repository: "fixture-repo",
        confidence: 1,
        tags: ["preference", "user"],
      });

      const result = await assembleRecall({
        db,
        prompt: "please tidy up the code",
        repository: "fixture-repo",
        config,
      });

      assert.deepEqual(result.trace.lookups.localMemories.includedRows.map((row) => row.id), ["repo-code-style"]);
      assert.deepEqual(result.trace.lookups.localMemories.filtered, []);
      assert.match(result.text, /Keep two-space indentation/);
    } finally {
      cleanup();
    }
  });
});
