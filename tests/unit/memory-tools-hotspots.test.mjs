import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { createMemoryTools } from "../../lib/memory-tools.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";
import { findTool } from "../helpers/tool-helpers.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

const MODULE_SOURCES = {
  root: readFileSync(new URL("../../lib/memory-tools.mjs", import.meta.url), "utf8"),
  helpers: readFileSync(new URL("../../lib/memory-tools-helpers.mjs", import.meta.url), "utf8"),
  reports: existsSync(new URL("../../lib/memory-tools-reports.mjs", import.meta.url))
    ? readFileSync(new URL("../../lib/memory-tools-reports.mjs", import.meta.url), "utf8")
    : null,
  builders: readFileSync(new URL("../../lib/memory-tools-builders.mjs", import.meta.url), "utf8"),
};

function countLines(source) {
  return source.trim().split("\n").length;
}

function buildRuntime(db, config, overrides = {}) {
  return {
    initialized: true,
    lastError: null,
    db,
    config,
    repository: "fixture-repo",
    ...overrides,
  };
}

async function setupFixtureTools(configOverrides = {}, runtimeOverrides = {}) {
  const fixture = await withFixtureDb({ configOverrides });
  return {
    ...fixture,
    tools: createMemoryTools({
      getRuntime: async () => buildRuntime(fixture.db, fixture.config, runtimeOverrides),
    }),
  };
}

describe("memory-tools module split", () => {
  test("keeps the root file tiny and pushes implementation into smaller modules", () => {
    assert.ok(countLines(MODULE_SOURCES.root) <= 10, "memory-tools.mjs should stay as a thin entrypoint");
    assert.ok(countLines(MODULE_SOURCES.helpers) <= 950, "memory-tools-helpers.mjs should stay file-scoped");
    assert.ok(countLines(MODULE_SOURCES.reports) <= 1300, "memory-tools-reports.mjs should stay file-scoped");
    assert.ok(countLines(MODULE_SOURCES.builders) <= 1650, "memory-tools-builders.mjs should stay file-scoped");
  });

  test("createMemoryTools still returns the manifest-backed tool set", async () => {
    const { tools, cleanup } = await setupFixtureTools({ enabled: true });
    try {
      assert.ok(Array.isArray(tools));
      assert.ok(tools.length > 0);
      assert.equal(findTool(tools, "memory_status").name, "memory_status");
      assert.equal(findTool(tools, "lore_onboard").name, "lore_onboard");
      assert.equal(findTool(tools, "memory_replay").name, "memory_replay");
    } finally {
      cleanup();
    }
  });
});

describe("memory-tools hotspot behavior", () => {
  test("searchSemantic keeps typed fallback opt-in for shared relevance searches", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });

    try {
      db.insertSemanticMemory({
        type: "user_preference",
        content: "Prefer narrow code review fixes with targeted validation.",
        scope: "transferable",
        repository: "other-repo",
      });

      const rows = db.searchSemantic({
        query: "network timeout oauth retries",
        repository: "fixture-repo",
        includeOtherRepositories: true,
        types: ["user_preference"],
        scopes: ["transferable"],
        limit: 5,
      });

      assert.deepEqual(rows, []);
    } finally {
      cleanup();
    }
  });

  test("memory_search with a type filter falls back to typed rows when lexical query misses", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, tools, cleanup } = await setupFixtureTools({
      enabled: true,
    });

    try {
      db.insertSemanticMemory({
        type: "open_loop",
        content: "Resolve the lingering README conflict before final review.",
        scope: "repo",
        repository: "fixture-repo",
      });
      db.insertSemanticMemory({
        type: "open_loop",
        content: "Triage pending follow-up actions for memory search parity.",
        scope: "repo",
        repository: "fixture-repo",
      });

      const memorySearch = findTool(tools, "memory_search");
      const output = await memorySearch.handler({
        query: "network timeout oauth retries",
        type: "open_loop",
        limit: 10,
      }, {
        sessionId: "memory-search-open-loop",
      });

      assert.match(output, /Resolve the lingering README conflict before final review\./);
      assert.match(output, /Triage pending follow-up actions for memory search parity\./);
    } finally {
      cleanup();
    }
  });

  test("memory_search typed fallback fills remaining slots without duplicate overlap", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, tools, cleanup } = await setupFixtureTools({
      enabled: true,
    });

    try {
      db.insertSemanticMemory({
        id: "open-loop-lexical-hit",
        type: "open_loop",
        content: "Address oauth timeout regression in memory search flow.",
        scope: "repo",
        repository: "fixture-repo",
        confidence: 1.0,
      });
      db.insertSemanticMemory({
        id: "open-loop-fallback-a",
        type: "open_loop",
        content: "Resolve dangling open loop triage after lexical fallback.",
        scope: "repo",
        repository: "fixture-repo",
        confidence: 0.1,
      });
      db.insertSemanticMemory({
        id: "open-loop-fallback-b",
        type: "open_loop",
        content: "Close assistant goal follow-ups discovered in maintenance.",
        scope: "repo",
        repository: "fixture-repo",
        confidence: 0.1,
      });

      const memorySearch = findTool(tools, "memory_search");
      const output = await memorySearch.handler({
        query: "oauth timeout regression",
        type: "open_loop",
        limit: 2,
      }, {
        sessionId: "memory-search-overlap-fallback",
      });

      assert.match(output, /Address oauth timeout regression in memory search flow\./);
      assert.equal((output.match(/\[open-loop-/g) || []).length, 2);
    } finally {
      cleanup();
    }
  });

  test("memory_intent_journal records and lists entries with repository defaults", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
        },
      },
    });

    try {
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config),
      });
      const journal = findTool(tools, "memory_intent_journal");

      const recordOutput = await journal.handler({
        action: "record",
        kind: "routing",
        summary: "Route to memory recall",
        rationale: "Need repo-specific history",
        context: { route: "memory_recall" },
      }, {
        sessionId: "intent-session",
      });

      const listOutput = await journal.handler({
        action: "list",
        kind: "routing",
        limit: 5,
      }, {
        sessionId: "intent-session",
      });

      assert.match(recordOutput, /Recorded intent journal entry .* \(routing\)\./);
      assert.match(listOutput, /repository: fixture-repo/);
      assert.match(listOutput, /kindFilter: routing/);
      assert.match(listOutput, /summary=Route to memory recall/);
      assert.match(listOutput, /contextKeys=route/);
    } finally {
      cleanup();
    }
  });

  test("memory_evolution_ledger summarizes captured signal clusters by derived theme", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          evolutionLedger: true,
        },
      },
    });

    try {
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config),
      });
      const ledger = findTool(tools, "memory_evolution_ledger");

      await ledger.handler({
        action: "capture_signal",
        signalType: "router",
        title: "Router miss",
        summary: "Missed a reusable route",
        sourceCaseId: "router-case-1",
      }, {
        sessionId: "ledger-session",
      });
      await ledger.handler({
        action: "capture_signal",
        signalType: "router",
        title: "Router retry",
        summary: "Captured another router miss",
        sourceCaseId: "router-case-2",
      }, {
        sessionId: "ledger-session",
      });

      const summaryOutput = await ledger.handler({
        action: "summary",
        limit: 10,
      }, {
        sessionId: "ledger-session",
      });

      assert.match(summaryOutput, /evolutionLedgerEnabled: true/);
      assert.match(summaryOutput, /## Active Artifact Clusters/);
      assert.match(summaryOutput, /signal:signal:router/);
      assert.match(summaryOutput, /count=2/);
    } finally {
      cleanup();
    }
  });

  test("memory_improvement_backlog resolves and supersedes artifacts through the public tool", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, tools, cleanup } = await setupFixtureTools({
      enabled: true,
    });

    try {
      const backlog = findTool(tools, "memory_improvement_backlog");
      const resolvedId = db.upsertImprovementArtifact({
        sourceCaseId: "hotspot-resolve",
        sourceKind: "signal",
        title: "Resolve hotspot artifact",
        summary: "Exercise the resolve path.",
      });
      const supersededId = db.upsertImprovementArtifact({
        sourceCaseId: "hotspot-supersede",
        sourceKind: "session",
        title: "Supersede hotspot artifact",
        summary: "Exercise the supersede path.",
      });

      const listOutput = await backlog.handler({
        action: "list",
        limit: 5,
      }, {
        sessionId: "improvement-backlog",
      });
      const resolveOutput = await backlog.handler({
        action: "resolve",
        id: resolvedId,
      }, {
        sessionId: "improvement-backlog",
      });
      const supersedeOutput = await backlog.handler({
        action: "supersede",
        id: supersededId,
        supersededBy: resolvedId,
      }, {
        sessionId: "improvement-backlog",
      });

      assert.match(listOutput, /## Improvement Backlog/);
      assert.match(listOutput, new RegExp(resolvedId));
      assert.equal(resolveOutput, `Resolved improvement artifact ${resolvedId}.`);
      assert.equal(supersedeOutput, `Superseded improvement artifact ${supersededId} with ${resolvedId}.`);
      assert.equal(db.listImprovementArtifacts({ status: "resolved", limit: 5 })[0]?.id, resolvedId);
      assert.equal(db.listImprovementArtifacts({ status: "superseded", limit: 5 })[0]?.id, supersededId);
    } finally {
      cleanup();
    }
  });

  test("memory_save and memory_deferred_process exercise the public handler paths", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, tools, cleanup } = await setupFixtureTools({
      enabled: true,
    }, {
      sessionStore: null,
    });

    try {
      const save = findTool(tools, "memory_save");
      const deferred = findTool(tools, "memory_deferred_process");

      const saveOutput = await save.handler({
        type: "user_preference",
        content: "Prefer exact envelope regression tests.",
      }, {
        sessionId: "memory-save",
      });
      const deferredOutput = await deferred.handler({
        limit: 2,
      }, {
        sessionId: "memory-deferred",
      });

      assert.match(saveOutput, /Saved semantic memory/);
      assert.equal(
        db.searchSemantic({
          query: "exact envelope regression tests",
          repository: "fixture-repo",
          includeOtherRepositories: false,
          types: ["user_preference"],
          limit: 2,
        }).length > 0,
        true,
      );
      assert.equal(
        deferredOutput,
        [
          "Processed 0 deferred job(s), failed 0, inspected 0.",
          "Local inference used 0, fell back 0.",
        ].join("\n"),
      );
    } finally {
      cleanup();
    }
  });

  test("memory_scope_override previews by default and applies when explicitly requested", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
        },
      },
    });

    try {
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config),
      });
      const scopeOverride = findTool(tools, "memory_scope_override");
      const memoryId = db.insertSemanticMemory({
        type: "directive",
        content: "Prefer focused regression tests before refactors.",
        scope: "global",
        repository: null,
      });

      const previewOutput = await scopeOverride.handler({
        targetType: "semantic",
        ids: [memoryId],
        scope: "repo",
      }, {
        sessionId: "scope-session",
      });

      const appliedOutput = await scopeOverride.handler({
        targetType: "semantic",
        ids: [memoryId],
        action: "set",
        scope: "repo",
        repository: "fixture-repo",
        dryRun: false,
        reason: "Need repo-specific scope for follow-up testing",
      }, {
        sessionId: "scope-session",
      });

      assert.match(previewOutput, /action: set/);
      assert.match(previewOutput, /matchedCount: 1/);
      assert.match(previewOutput, /next=repo/);
      assert.match(appliedOutput, /Applied set override to 1 semantic row\(s\)\./);
      const auditRows = db.listScopeOverrideAudit({ limit: 5 });
      assert.equal(auditRows[0]?.reason, "Need repo-specific scope for follow-up testing");
    } finally {
      cleanup();
    }
  });
});
