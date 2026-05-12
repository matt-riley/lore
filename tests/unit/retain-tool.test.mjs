import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createMemoryTools } from "../../lib/memory-tools.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";
import { findTool } from "../helpers/tool-helpers.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

describe("lore_retain tool", () => {
  test("returns a clear rollout-disabled message for domain-backed retains", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryDomains: false,
          workstreamOverlays: true,
        },
      },
    });

    try {
      const tools = createMemoryTools({
        getRuntime: async () => ({
          initialized: true,
          lastError: null,
          db,
          config,
          repository: "fixture-repo",
        }),
      });
      const output = await findTool(tools, "lore_retain").handler({
        kind: "semantic",
        type: "user_preference",
        content: "Prefer concise answers.",
        domainKey: "communication",
      }, {
        sessionId: "retain-domain-disabled",
      });

      assert.equal(output, "Skipped semantic memory retain: memory domains rollout is disabled");
    } finally {
      cleanup();
    }
  });

  test("retains workstream overlays and semantic memories through the public tool", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
          workstreamOverlays: true,
          memoryDomains: true,
        },
      },
    });

    try {
      const tools = createMemoryTools({
        getRuntime: async () => ({
          initialized: true,
          lastError: null,
          db,
          config,
          repository: "fixture-repo",
        }),
      });
      const retain = findTool(tools, "lore_retain");

      const workstreamOutput = await retain.handler({
        kind: "workstream",
        workstreamId: "retrieval-hotspots",
        title: "Retrieval hotspots",
        objective: "Reduce the remaining Fallow findings",
        nextActions: ["Split prompt routing helpers"],
      }, {
        sessionId: "retain-workstream",
      });
      const semanticOutput = await retain.handler({
        kind: "semantic",
        type: "user_preference",
        content: "Prefer focused regression tests before hotspot refactors.",
        domainKey: "communication",
        tags: ["tests", "fallow"],
      }, {
        sessionId: "retain-semantic",
      });

      assert.match(workstreamOutput, /Retained workstream overlay/);
      assert.match(semanticOutput, /Retained semantic memory/);

      const workstreamRows = db.searchSemantic({
        query: "",
        repository: "fixture-repo",
        includeOtherRepositories: false,
        types: ["workstream_overlay"],
        limit: 2,
      });
      const semanticRows = db.searchSemantic({
        query: "focused regression tests",
        repository: "fixture-repo",
        includeOtherRepositories: false,
        types: ["user_preference"],
        limit: 2,
      });

      assert.equal(workstreamRows.length > 0, true);
      assert.equal(semanticRows.length > 0, true);
      assert.equal(db.getMemoryDomain("communication")?.domainKey, "communication");
    } finally {
      cleanup();
    }
  });

  test("applies domain prechecks before the workstream branch", { skip: SKIP_NO_FTS5 }, async () => {
    const disabledFixture = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
          workstreamOverlays: true,
          memoryDomains: false,
        },
      },
    });
    const enabledFixture = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
          workstreamOverlays: true,
          memoryDomains: true,
        },
      },
    });

    try {
      const disabledRetain = findTool(createMemoryTools({
        getRuntime: async () => ({
          initialized: true,
          lastError: null,
          db: disabledFixture.db,
          config: disabledFixture.config,
          repository: "fixture-repo",
        }),
      }), "lore_retain");
      const enabledRetain = findTool(createMemoryTools({
        getRuntime: async () => ({
          initialized: true,
          lastError: null,
          db: enabledFixture.db,
          config: enabledFixture.config,
          repository: "fixture-repo",
        }),
      }), "lore_retain");

      const disabledOutput = await disabledRetain.handler({
        kind: "workstream",
        domainKey: "delivery",
        workstreamId: "retain-domain-workstream-disabled",
        title: "Delivery",
      }, {
        sessionId: "retain-domain-workstream-disabled",
      });
      const enabledOutput = await enabledRetain.handler({
        kind: "workstream",
        domainKey: "delivery",
        workstreamId: "retain-domain-workstream-enabled",
        title: "Delivery",
      }, {
        sessionId: "retain-domain-workstream-enabled",
      });

      assert.equal(disabledOutput, "Skipped semantic memory retain: memory domains rollout is disabled");
      assert.match(enabledOutput, /Retained workstream overlay/);
      assert.equal(enabledFixture.db.getMemoryDomain("delivery")?.domainKey, "delivery");
    } finally {
      disabledFixture.cleanup();
      enabledFixture.cleanup();
    }
  });
});
