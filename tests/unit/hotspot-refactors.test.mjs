import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { assembleMemoryCapsule } from "../../lib/capsule-assembler.mjs";
import { buildFixtureConfig } from "../helpers/fixture-config.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

const TEST_REPO = "owner/test-repo";
const OTHER_REPO = "owner/other-repo";

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-hotspot-refactors-"));
}

function makeEpisode({
  id,
  repository = TEST_REPO,
  summary,
  dateKey,
  decisions = [],
  openItems = [],
  actions = [],
  themes = [],
}) {
  return {
    id,
    session_id: `${id}-session`,
    repository,
    summary,
    date_key: dateKey,
    decisions_json: JSON.stringify(decisions),
    open_items_json: JSON.stringify(openItems),
    actions_json: JSON.stringify(actions),
    themes_json: JSON.stringify(themes),
    significance: 7,
    updated_at: `${dateKey}T12:00:00.000Z`,
  };
}

function makeCapsuleTrace({ repository, includeOtherRepositories = false, reason = null }) {
  return {
    prompt: "fixture prompt",
    repository,
    includeOtherRepositories,
    eligibleScopes: repository ? ["global", `repo:${repository}`] : ["global"],
    primaryTerms: [],
    terms: [],
    lexicalQuery: "",
    rankedRows: [],
    includedRows: [],
    filtered: [],
    reason,
  };
}

function makeCapsuleDbStub({
  localEpisodes = [],
  crossRepoEpisodes = [],
  crossRepoPreferences = [],
} = {}) {
  function buildEpisodeResult({
    repository,
    includeOtherRepositories = false,
    episodes = [],
    reason,
  }) {
    return {
      episodes,
      trace: makeCapsuleTrace({
        repository,
        includeOtherRepositories,
        reason,
      }),
    };
  }

  return {
    searchSemantic({
      includeOtherRepositories = false,
      types = [],
      scopes = [],
    } = {}) {
      if (includeOtherRepositories && scopes.includes("transferable") && types.includes("user_preference")) {
        return crossRepoPreferences;
      }
      return [];
    },
    listImprovementArtifacts() {
      return [];
    },
    findRelevantEpisodesDetailed({
      repository,
      includeOtherRepositories = false,
      scopes = [],
    } = {}) {
      if (includeOtherRepositories && scopes.includes("transferable")) {
        return buildEpisodeResult({
          repository,
          includeOtherRepositories,
          episodes: crossRepoEpisodes,
          reason: crossRepoEpisodes.length > 0 ? null : "no_cross_repo_examples",
        });
      }
      return buildEpisodeResult({
        repository,
        includeOtherRepositories,
        episodes: localEpisodes,
        reason: localEpisodes.length > 0 ? null : "no_matching_episode_rows",
      });
    },
    findRelevantEpisodes({
      repository,
      includeOtherRepositories = false,
      scopes = [],
    } = {}) {
      if (includeOtherRepositories && scopes.includes("transferable")) {
        return crossRepoEpisodes;
      }
      return localEpisodes;
    },
  };
}

describe("LoreDb.getStats", () => {
  test("returns grouped counts, zero defaults, and last success activity", { skip: SKIP_NO_FTS5 }, async () => {
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
        type: "assistant_goal",
        content: "Keep Lore responses grounded in repository behavior.",
        scope: "global",
        repository: null,
      });
      db.insertSemanticMemory({
        type: "recurring_mistake",
        content: "Do not regress temporal provenance trace fields.",
        scope: "repo",
        repository: TEST_REPO,
        reinforcementCount: 2,
      });
      db.insertSemanticMemory({
        type: "user_identity",
        content: "The user's preferred name is Matt.",
        scope: "global",
        repository: null,
      });
      db.insertSemanticMemory({
        type: "workstream_overlay",
        content: "Active workstream tracks hotspot cleanup.",
        scope: "repo",
        repository: TEST_REPO,
      });
      db.insertSemanticMemory({
        type: "directive",
        content: "Prefer behavior-safe refactors.",
        scope: "transferable",
        repository: null,
      });

      db.upsertEpisodeDigest({
        id: "stats-episode",
        sessionId: "stats-session",
        repository: TEST_REPO,
        summary: "Refactored the hotspot-reporting path.",
        actions: ["refactored helpers"],
        decisions: ["kept trace output stable"],
        learnings: [],
        filesChanged: [],
        refs: [],
        significance: 7,
        themes: ["maintenance"],
        openItems: [],
        dateKey: "2024-04-01",
        createdAt: "2024-04-01T10:00:00.000Z",
      });
      db.refreshDaySummary({ date: "2024-04-01", repository: TEST_REPO });
      db.upsertActivitySuccess({
        updates: {
          lastContextInjectionAt: "2024-04-02T10:00:00.000Z",
          lastContextInjectionHook: "onUserPromptSubmitted",
          lastContextInjectionSections: ["Relevant Knowledge", "Recent Related Work"],
          lastContextInjectionTraceId: "trace-ctx-1",
          lastContextInjectionDurationMs: 42,
          lastExtractionCompletionAt: "2024-04-02T11:00:00.000Z",
          lastExtractionRepository: TEST_REPO,
          lastMaintenanceCompletionAt: "2024-04-02T12:00:00.000Z",
          lastMaintenanceStatus: "completed",
          lastMaintenanceRunId: "maintenance-1",
          lastTraceRecordedAt: "2024-04-02T13:00:00.000Z",
          lastTraceHook: "onUserPromptSubmitted",
          lastTraceId: "trace-sample-1",
        },
      });

      const stats = db.getStats();

      assert.equal(stats.semanticCount, 5);
      assert.equal(stats.episodeCount, 1);
      assert.equal(stats.daySummaryCount, 1);
      assert.equal(stats.domainCount, 0);
      assert.equal(stats.observationCount, 0);

      assert.equal(stats.semanticGlobalCount, 2);
      assert.equal(stats.semanticTransferableCount, 1);
      assert.equal(stats.semanticRepoCount, 2);
      assert.equal(stats.semanticManualCount, 0);
      assert.equal(stats.episodeGlobalCount, 0);
      assert.equal(stats.episodeTransferableCount, 0);
      assert.equal(stats.episodeRepoCount, 1);
      assert.equal(stats.episodeManualCount, 0);

      assert.equal(stats.assistantGoalCount, 1);
      assert.equal(stats.recurringMistakeCount, 1);
      assert.equal(stats.userIdentityCount, 1);
      assert.equal(stats.workstreamOverlayCount, 1);
      assert.equal(stats.directiveCount, 1);
      assert.equal(stats.semanticReinforcedCount, 1);

      assert.equal(stats.improvementCount, 0);
      assert.equal(stats.improvementActiveCount, 0);
      assert.equal(stats.improvementResolvedCount, 0);
      assert.equal(stats.improvementSupersededCount, 0);
      assert.equal(stats.deferredPendingCount, 0);
      assert.equal(stats.deferredRunningCount, 0);
      assert.equal(stats.deferredFailedCount, 0);
      assert.equal(stats.backfillRunningCount, 0);
      assert.equal(stats.backfillCompletedCount, 0);
      assert.equal(stats.backfillFailedCount, 0);
      assert.equal(stats.maintenanceTaskStateCount, 0);
      assert.equal(stats.retrievalTraceSampleCount, 0);
      assert.equal(stats.retrievalTraceSampleGlobalCount, 0);
      assert.equal(stats.retrievalTraceSampleRepositoryCount, 0);

      assert.equal(stats.dbPath, config.paths.derivedStorePath);
      assert.equal(stats.backupDir, config.paths.backupDir);
      assert.equal(stats.lastBackupPath, null);
      assert.equal(stats.lastMaintenanceStatus, null);
      assert.equal(stats.lastMaintenanceStartedAt, null);
      assert.equal(stats.lastMaintenanceCompletedAt, null);

      assert.deepEqual(stats.lastSuccessActivity, {
        scopeKey: "global",
        scopeType: "global",
        repository: null,
        lastContextInjectionAt: "2024-04-02T10:00:00.000Z",
        lastContextInjectionHook: "onUserPromptSubmitted",
        lastContextInjectionSections: ["Relevant Knowledge", "Recent Related Work"],
        lastContextInjectionTraceId: "trace-ctx-1",
        lastContextInjectionDurationMs: 42,
        lastExtractionCompletionAt: "2024-04-02T11:00:00.000Z",
        lastExtractionRepository: TEST_REPO,
        lastMaintenanceCompletionAt: "2024-04-02T12:00:00.000Z",
        lastMaintenanceStatus: "completed",
        lastMaintenanceRunId: "maintenance-1",
        lastTraceRecordedAt: "2024-04-02T13:00:00.000Z",
        lastTraceHook: "onUserPromptSubmitted",
        lastTraceId: "trace-sample-1",
        updatedAt: stats.lastSuccessActivity.updatedAt,
      });
      assert.match(stats.lastSuccessActivity.updatedAt, /^20\d\d-/);
    } finally {
      cleanup();
    }
  });
});

describe("LoreDb.upsertActivitySuccess", () => {
  test("truncates sections, preserves null section updates, and keeps repo extraction fallback stable", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
        },
      },
    });

    try {
      db.upsertActivitySuccess({
        repository: TEST_REPO,
        updates: {
          lastContextInjectionAt: "2024-04-05T10:00:00.000Z",
          lastContextInjectionSections: [
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
          ],
          lastTraceId: "trace-1",
        },
      });

      let [activityState] = db.getActivityState({ repository: TEST_REPO, includeGlobal: false });
      assert.deepEqual(activityState.lastContextInjectionSections, [
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
      ]);
      assert.equal(activityState.lastExtractionRepository, TEST_REPO);

      db.upsertActivitySuccess({
        repository: TEST_REPO,
        updates: {
          lastContextInjectionSections: [],
          lastExtractionRepository: OTHER_REPO,
        },
      });

      [activityState] = db.getActivityState({ repository: TEST_REPO, includeGlobal: false });
      assert.deepEqual(activityState.lastContextInjectionSections, []);
      assert.equal(activityState.lastExtractionRepository, OTHER_REPO);

      db.upsertActivitySuccess({
        repository: TEST_REPO,
        updates: {
          lastContextInjectionSections: null,
          lastTraceId: "trace-2",
        },
      });

      [activityState] = db.getActivityState({ repository: TEST_REPO, includeGlobal: false });
      assert.deepEqual(activityState.lastContextInjectionSections, []);
      assert.equal(activityState.lastTraceId, "trace-2");
      assert.equal(activityState.lastExtractionRepository, OTHER_REPO);

      db.upsertActivitySuccess({
        repository: TEST_REPO,
        updates: {},
      });

      [activityState] = db.getActivityState({ repository: TEST_REPO, includeGlobal: false });
      assert.deepEqual(activityState.lastContextInjectionSections, []);
      assert.equal(activityState.lastExtractionRepository, OTHER_REPO);
    } finally {
      cleanup();
    }
  });

  test("falls back to repository-scoped latest extraction timestamps without leaking other repositories", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });

    try {
      db.insertSemanticMemory({
        id: "repo-memory",
        type: "fact",
        content: "Repo memory",
        repository: TEST_REPO,
        scope: "repo",
        updatedAt: "2024-04-05T10:00:00.000Z",
      });
      db.insertSemanticMemory({
        id: "other-memory",
        type: "fact",
        content: "Other repo memory",
        repository: OTHER_REPO,
        scope: "repo",
        updatedAt: "2024-04-05T13:00:00.000Z",
      });
      db.upsertEpisodeDigest({
        id: "repo-episode",
        sessionId: "repo-session",
        repository: TEST_REPO,
        scope: "repo",
        summary: "Repo episode",
        actions: ["repo action"],
        decisions: [],
        learnings: [],
        filesChanged: [],
        refs: [],
        significance: 5,
        themes: ["repo"],
        openItems: [],
        dateKey: "2024-04-05",
        createdAt: "2024-04-05T09:00:00.000Z",
      });
      db.upsertEpisodeDigest({
        id: "other-episode",
        sessionId: "other-session",
        repository: OTHER_REPO,
        scope: "repo",
        summary: "Other episode",
        actions: ["other action"],
        decisions: [],
        learnings: [],
        filesChanged: [],
        refs: [],
        significance: 5,
        themes: ["other"],
        openItems: [],
        dateKey: "2024-04-05",
        createdAt: "2024-04-05T09:30:00.000Z",
      });

      const [activityState] = db.getActivityState({
        repository: TEST_REPO,
        includeGlobal: false,
      });

      assert.equal(activityState.repository, TEST_REPO);
      assert.match(activityState.lastExtractionCompletionAt, /^20\d\d-/);
      assert.equal(activityState.lastExtractionRepository, TEST_REPO);
    } finally {
      cleanup();
    }
  });

  test("uses caller-supplied semantic memory updatedAt for extraction fallback timestamps", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });

    try {
      db.insertSemanticMemory({
        id: "dated-memory",
        type: "fact",
        content: "Repo extraction fallback should respect imported timestamps",
        repository: TEST_REPO,
        scope: "repo",
        updatedAt: "2024-04-05T10:00:00.000Z",
      });

      const [activityState] = db.getActivityState({
        repository: TEST_REPO,
        includeGlobal: false,
      });

      assert.equal(activityState.lastExtractionCompletionAt, "2024-04-05T10:00:00.000Z");
      assert.equal(activityState.lastExtractionRepository, TEST_REPO);
    } finally {
      cleanup();
    }
  });
});

describe("assembleMemoryCapsule", () => {
  test("keeps local related-work fallbacks suppressed once three episode lines are present", async () => {
    const tempHome = makeTempDir();
    try {
      const config = buildFixtureConfig(tempHome);
      let historySearchCalls = 0;
      let relatedSessionCalls = 0;
      let rawSessionCalls = 0;
      const db = makeCapsuleDbStub({
        localEpisodes: [
          makeEpisode({
            id: "ep-1",
            dateKey: "2024-04-01",
            summary: "Updated auth token rotation",
            decisions: ["Rotate refresh tokens"],
            themes: ["auth"],
          }),
          makeEpisode({
            id: "ep-2",
            dateKey: "2024-04-02",
            summary: "Backfilled auth retry tests",
            openItems: ["Clean up retry metrics"],
            themes: ["testing"],
          }),
          makeEpisode({
            id: "ep-3",
            dateKey: "2024-04-03",
            summary: "Documented auth rollout follow-up",
            actions: ["updated docs"],
            themes: ["docs"],
          }),
        ],
      });
      const sessionStore = {
        searchIndex() {
          historySearchCalls += 1;
          return [];
        },
        findRelevantSessions() {
          relatedSessionCalls += 1;
          return [];
        },
        getRecentSessions() {
          rawSessionCalls += 1;
          return [];
        },
      };

      const result = await assembleMemoryCapsule({
        prompt: "continue auth migration",
        repository: TEST_REPO,
        proceduralProfile: "",
        db,
        sessionStore,
        config,
        includeTrace: true,
      });

      assert.match(result.text, /## Recent Related Work/);
      assert.equal(result.trace.lookups.historyHints.reason, "local_episode_results_present");
      assert.equal(result.trace.lookups.longRangeHints.reason, "local_episode_results_sufficient");
      assert.equal(result.trace.lookups.rawSessions.reason, "higher_priority_results_present");
      assert.equal(historySearchCalls, 0);
      assert.equal(relatedSessionCalls, 0);
      assert.equal(rawSessionCalls, 0);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("keeps cross-repo hints suppressed when transferable episode examples already exist", async () => {
    const tempHome = makeTempDir();
    try {
      const config = buildFixtureConfig(tempHome);
      const db = makeCapsuleDbStub({
        crossRepoEpisodes: [
          makeEpisode({
            id: "cross-ep-1",
            repository: OTHER_REPO,
            dateKey: "2024-04-04",
            summary: "Migrated auth workflow in another repo",
            decisions: ["Reuse the release guardrail"],
            themes: ["ci"],
          }),
        ],
        crossRepoPreferences: [
          {
            id: "pref-1",
            type: "user_preference",
            scope: "transferable",
            repository: OTHER_REPO,
            content: "Prefer reusing the existing release playbook.",
            updated_at: "2024-04-04T12:00:00.000Z",
          },
        ],
      });
      const sessionStore = {
        searchIndex() {
          return [];
        },
        findRelevantSessions() {
          throw new Error("cross-repo hints should not run when examples already exist");
        },
        getRecentSessions() {
          throw new Error("raw session fallback should stay disabled for cross-repo-only prompts");
        },
      };

      const result = await assembleMemoryCapsule({
        prompt: "show cross-repo auth examples",
        repository: TEST_REPO,
        proceduralProfile: "",
        db,
        sessionStore,
        config,
        includeTrace: true,
      });

      assert.match(result.text, /## Cross-Repo Examples/);
      assert.doesNotMatch(result.text, /## Cross-Repo Hints/);
      assert.match(result.text, /\[example from owner\/other-repo\]/);
      assert.equal(result.trace.lookups.crossRepoExamples.includedRows.length, 1);
      assert.equal(result.trace.lookups.crossRepoPreferences.includedRows.length, 1);
      assert.equal(result.trace.lookups.localEpisodes.reason, "identity_only_prompt");
      assert.equal(result.trace.lookups.rawSessions.reason, "identity_only_prompt");
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("adds long-range hints after sparse history hints and skips raw-session fallback", async () => {
    const tempHome = makeTempDir();
    try {
      const config = buildFixtureConfig(tempHome);
      let historySearchCalls = 0;
      let relatedSessionCalls = 0;
      let rawSessionCalls = 0;
      const db = makeCapsuleDbStub();
      const sessionStore = {
        searchIndex() {
          historySearchCalls += 1;
          return [
            {
              source_type: "turn",
              repository: TEST_REPO,
              updated_at: "2024-04-05T10:00:00.000Z",
              content: "Captured an auth rollback history hint.",
            },
          ];
        },
        findRelevantSessions() {
          relatedSessionCalls += 1;
          return [
            {
              session_id: "history-session-1",
              source_type: "turn",
              repository: TEST_REPO,
              updated_at: "2024-04-06T11:00:00.000Z",
              excerpt: "Backfilled rollback smoke tests after the hint landed.",
            },
          ];
        },
        getRecentSessions() {
          rawSessionCalls += 1;
          return [];
        },
      };

      const result = await assembleMemoryCapsule({
        prompt: "continue auth migration",
        repository: TEST_REPO,
        proceduralProfile: "",
        db,
        sessionStore,
        config,
        includeTrace: true,
      });

      assert.match(result.text, /## Relevant History Hints/);
      assert.match(result.text, /## Long-Range Related Hints/);
      assert.equal(result.trace.lookups.historyHints.reason, null);
      assert.equal(result.trace.lookups.longRangeHints.reason, null);
      assert.equal(result.trace.lookups.rawSessions.reason, "higher_priority_results_present");
      assert.equal(historySearchCalls, 1);
      assert.equal(relatedSessionCalls, 1);
      assert.equal(rawSessionCalls, 0);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("falls back to recent workspace activity after episode and history hints miss", async () => {
    const tempHome = makeTempDir();
    try {
      const config = buildFixtureConfig(tempHome);
      const db = makeCapsuleDbStub();
      const sessionStore = {
        searchIndex() {
          return [];
        },
        findRelevantSessions() {
          return [];
        },
        getRecentSessions() {
          return [
            {
              repository: TEST_REPO,
              branch: "main",
              updated_at: "2024-04-07T12:00:00.000Z",
              summary: "Updated retry metrics smoke coverage.",
            },
          ];
        },
      };

      const result = await assembleMemoryCapsule({
        prompt: "continue auth migration",
        repository: TEST_REPO,
        proceduralProfile: "",
        db,
        sessionStore,
        config,
        includeTrace: true,
      });

      assert.match(result.text, /## Recent Workspace Activity/);
      assert.equal(result.trace.lookups.historyHints.reason, "no_history_hits");
      assert.equal(result.trace.lookups.longRangeHints.reason, "no_long_range_hints");
      assert.equal(result.trace.lookups.rawSessions.reason, null);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("skips repo-local style lookups when a serious prompt suppresses ambient style guidance", async () => {
    const tempHome = makeTempDir();
    try {
      const config = buildFixtureConfig(tempHome, {
        rollout: {
          ambientPersonaMode: true,
        },
      });
      const searchCalls = [];
      const db = {
        searchSemantic(params = {}) {
          searchCalls.push(params);
          return [];
        },
        listImprovementArtifacts() {
          return [];
        },
        findRelevantEpisodesDetailed() {
          return {
            episodes: [],
            trace: makeCapsuleTrace({
              repository: TEST_REPO,
              reason: "no_matching_episode_rows",
            }),
          };
        },
        findRelevantEpisodes() {
          return [];
        },
      };
      const sessionStore = {
        searchIndex() {
          return [];
        },
        findRelevantSessions() {
          return [];
        },
        getRecentSessions() {
          return [];
        },
      };

      const result = await assembleMemoryCapsule({
        prompt: "sev1 incident: investigate the auth outage",
        repository: TEST_REPO,
        proceduralProfile: "",
        db,
        sessionStore,
        config,
        includeTrace: true,
      });

      assert.doesNotMatch(result.text, /## Response Style And Addressing/);
      assert.equal(
        result.trace.omissions.find((entry) => entry.stage === "style_addressing")?.reason,
        "ambient_suppressed_for_serious_or_temporal_prompt",
      );
      assert.equal(
        searchCalls.filter((call) => (
          call.repository === TEST_REPO
          && call.query === "assistant preferred human name"
          && call.types?.includes("assistant_identity")
        )).length,
        0,
      );
      assert.equal(
        searchCalls.filter((call) => (
          call.repository === TEST_REPO
          && call.query === ""
          && call.types?.includes("interaction_style")
          && call.types?.includes("user_preference")
          && call.types?.includes("recurring_mistake")
        )).length,
        0,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
