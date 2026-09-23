import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createMemoryTools } from "../../lib/tools/memory-tools.mjs";
import {
  buildOnboardingMemories,
  buildOnboardingSection,
  readOnboardingState,
  resolveOnboardingInput,
  seedOnboardingMemories,
} from "../../lib/memory/onboarding.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE && "FTS5 not available in this Node build";

const BASE_ROLLOUT = {
  memoryOperations: true,
  workstreamOverlays: true,
  temporalQueryNormalization: true,
  retentionSanitization: true,
  directives: true,
  hybridRetrieval: true,
};

const AMBIENT_ROLLOUT = { ambientPersonaMode: true, ...BASE_ROLLOUT };

describe("buildOnboardingMemories", () => {
  test("chooses an assistant name during onboarding when none is provided", () => {
    const built = buildOnboardingMemories({
      userName: "matt",
      sessionId: "session-1",
    });

    assert.ok(built.assistantName);
    assert.strictEqual(built.userName, "Matt");
    assert.strictEqual(built.profile.voice, "colleague");
    assert.strictEqual(built.profile.warmth, "warm");
    assert.strictEqual(built.profile.humor, "light");
    assert.strictEqual(built.profile.humorFrequency, "occasional");
    assert.strictEqual(built.memories.length, 3);
  });
});

describe("resolveOnboardingInput", () => {
  test("reuses the stored user name when lore_onboard is called without one", () => {
    const built = resolveOnboardingInput({
      existingState: {
        userName: "Matt",
        assistantName: null,
      },
      sessionId: "session-2",
    });

    assert.strictEqual(built.userName, "Matt");
    assert.ok(built.assistantName);
  });
});

describe("onboarding state", () => {
  test("seedOnboardingMemories seeds only interaction style on a fresh db", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: BASE_ROLLOUT,
      },
    });

    try {
      const seeded = seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      assert.strictEqual(seeded.insertedCount, 1);

      const state = readOnboardingState({ db });
      assert.strictEqual(state.assistantName, null);
      assert.strictEqual(state.hasAssistantIdentity, false);
      assert.strictEqual(state.hasInteractionStyle, true);
      assert.strictEqual(state.hasUserName, false);
      assert.deepStrictEqual(state.missing, ["assistantName", "userName"]);
    } finally {
      cleanup();
    }
  });

  test("generated semantic cleanup preserves seeded onboarding style memories", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: BASE_ROLLOUT,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      assert.strictEqual(db.countGeneratedSemanticMemoriesBySession("session-seed"), 0);

      db.deleteGeneratedSemanticMemories("session-seed");

      const state = readOnboardingState({ db });
      assert.strictEqual(state.hasInteractionStyle, true);
    } finally {
      cleanup();
    }
  });

  test("buildOnboardingSection asks for the user's preferred name and points at lore_onboard", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: BASE_ROLLOUT,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      const section = buildOnboardingSection({
        db,
        promptNeed: {
          seriousPrompt: false,
        },
      });

      assert.match(section.text, /What should I call you\?/);
      assert.match(section.text, /lore_onboard/);
      assert.match(section.text, /pick its own name with a little personality/);
    } finally {
      cleanup();
    }
  });

  test("buildOnboardingSection tells Lore to finish naming itself once the user name is known", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: BASE_ROLLOUT,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });
      db.insertSemanticMemory({
        type: "user_identity",
        content: "The user's preferred name is Matt.",
        scope: "global",
        repository: null,
        metadata: {
          source: "test",
          preferredName: "Matt",
        },
      });

      const section = buildOnboardingSection({
        db,
        promptNeed: {
          seriousPrompt: false,
        },
      });

      assert.match(section.text, /already knows the user's preferred name: "Matt"/);
      assert.match(section.text, /If you were human, what would you like your name to be\?/);
      assert.match(section.text, /You can call me <chosen name>/);
    } finally {
      cleanup();
    }
  });

  test("buildOnboardingSection emits a complete trace with empty missing list once onboarding is done", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });

    try {
      const built = buildOnboardingMemories({
        userName: "Matt",
        assistantName: "Coda",
        sessionId: "session-complete",
      });
      for (const memory of built.memories) {
        db.insertSemanticMemory(memory);
      }

      const section = buildOnboardingSection({
        db,
        promptNeed: {
          seriousPrompt: false,
        },
      });

      assert.equal(section.text, "");
      assert.deepEqual(section.trace, {
        enabled: false,
        reason: "complete",
        missing: [],
        assistantName: "Coda",
      });
    } finally {
      cleanup();
    }
  });

  test("buildOnboardingSection keeps missing fields on serious prompts", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-serious",
      });

      const section = buildOnboardingSection({
        db,
        promptNeed: {
          seriousPrompt: true,
        },
      });

      assert.equal(section.text, "");
      assert.deepEqual(section.trace, {
        enabled: false,
        reason: "serious_prompt",
        missing: ["assistantName", "userName"],
        assistantName: null,
      });
    } finally {
      cleanup();
    }
  });
});

function buildLoreOnboardTool(db, config) {
  const runtime = {
    initialized: true,
    lastError: null,
    db,
    config,
    repository: "fixture-repo",
    sessionStore: null,
  };
  const tools = createMemoryTools({ getRuntime: async () => runtime });
  return tools.find((tool) => tool.name === "lore_onboard");
}

describe("lore_onboard tool", () => {
  test("persists the user's preferred name and explicit style overrides", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: AMBIENT_ROLLOUT,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      const loreOnboard = buildLoreOnboardTool(db, config);
      assert.ok(loreOnboard, "expected lore_onboard tool to be registered");

      const result = await loreOnboard.handler({
        userName: "Matt",
        warmth: "balanced",
        humor: "none",
      }, {
        sessionId: "session-onboard",
      });

      assert.match(result, /Lore onboarding saved/);
      assert.match(result, /announceToUser=You can call me /);
      assert.match(result, /assistantNameSource=auto/);

      const state = readOnboardingState({ db });
      assert.ok(state.assistantName);
      assert.strictEqual(state.userName, "Matt");
      assert.strictEqual(state.hasUserName, true);

      const interactionStyle = db.searchSemantic({
        query: "",
        repository: null,
        includeOtherRepositories: false,
        types: ["interaction_style"],
        scopes: ["global"],
        limit: 1,
      })[0];

      assert.strictEqual(interactionStyle.metadata.profile.warmth, "balanced");
      assert.strictEqual(interactionStyle.metadata.profile.humor, "none");
      assert.strictEqual(interactionStyle.metadata.profile.humorFrequency, "never");
    } finally {
      cleanup();
    }
  });

  test("can finish onboarding without userName when Lore already knows it", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: AMBIENT_ROLLOUT,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });
      db.insertSemanticMemory({
        type: "user_identity",
        content: "The user's preferred name is Matt.",
        scope: "global",
        repository: null,
        metadata: {
          source: "test",
          preferredName: "Matt",
        },
      });

      const loreOnboard = buildLoreOnboardTool(db, config);

      const result = await loreOnboard.handler({
        warmth: "balanced",
      }, {
        sessionId: "session-onboard-2",
      });

      assert.match(result, /announceToUser=You can call me /);
      assert.match(result, /userName=Matt/);
      assert.match(result, /assistantNameSource=auto/);

      const state = readOnboardingState({ db });
      assert.strictEqual(state.userName, "Matt");
      assert.ok(state.assistantName);
    } finally {
      cleanup();
    }
  });

  test("cleanup preserves lore_onboard memories for the originating session", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: AMBIENT_ROLLOUT,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      const loreOnboard = buildLoreOnboardTool(db, config);
      assert.ok(loreOnboard, "expected lore_onboard tool to be registered");

      await loreOnboard.handler({
        userName: "Matt",
      }, {
        sessionId: "session-onboard",
      });

      assert.strictEqual(db.countGeneratedSemanticMemoriesBySession("session-onboard"), 0);

      db.deleteGeneratedSemanticMemories("session-onboard");

      const state = readOnboardingState({ db });
      assert.strictEqual(state.userName, "Matt");
      assert.ok(state.assistantName);
      assert.strictEqual(state.complete, true);
    } finally {
      cleanup();
    }
  });

  test("re-onboarding supersedes prior active rows of the same onboarding types", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: AMBIENT_ROLLOUT,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      const loreOnboard = buildLoreOnboardTool(db, config);

      await loreOnboard.handler({
        userName: "Matt",
        warmth: "warm",
        humor: "light",
      }, {
        sessionId: "session-onboard-1",
      });

      // Re-onboard with a different profile: the prior profile must be
      // superseded, not accumulated alongside the new one.
      await loreOnboard.handler({
        userName: "Matt",
        warmth: "balanced",
        humor: "none",
        humorFrequency: "never",
      }, {
        sessionId: "session-onboard-2",
      });

      const activeStyles = db.searchSemantic({
        query: "",
        repository: null,
        includeOtherRepositories: false,
        types: ["interaction_style"],
        scopes: ["global"],
        limit: 20,
      });

      assert.strictEqual(activeStyles.length, 1, "only one active interaction_style row should remain");
      assert.strictEqual(activeStyles[0].metadata.profile.warmth, "balanced");
      assert.strictEqual(activeStyles[0].metadata.profile.humor, "none");
    } finally {
      cleanup();
    }
  });

  test("re-onboarding with empty object after onboarding is a no-op", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: AMBIENT_ROLLOUT,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      const loreOnboard = buildLoreOnboardTool(db, config);

      // Initial onboarding with custom profile
      await loreOnboard.handler({
        userName: "Matt",
        warmth: "warm",
        humor: "light",
      }, {
        sessionId: "session-onboard-1",
      });

      const beforeRows = db.searchSemantic({
        query: "",
        repository: null,
        includeOtherRepositories: false,
        types: ["interaction_style"],
        scopes: ["global"],
        limit: 20,
      });
      const beforeRowId = beforeRows[0].id;
      const beforeUpdatedAt = beforeRows[0].updated_at;

      // Re-onboard with empty object (no-op)
      const result = await loreOnboard.handler({}, {
        sessionId: "session-onboard-2",
      });

      assert.match(result, /unchanged/i);

      const afterRows = db.searchSemantic({
        query: "",
        repository: null,
        includeOtherRepositories: false,
        types: ["interaction_style"],
        scopes: ["global"],
        limit: 20,
      });

      // Should still have only one active row with the same ID and unchanged metadata
      assert.strictEqual(afterRows.length, 1, "only one active interaction_style row should remain");
      assert.strictEqual(afterRows[0].id, beforeRowId, "row ID should not change");
      assert.strictEqual(afterRows[0].updated_at, beforeUpdatedAt, "updated_at should not change");
      assert.strictEqual(afterRows[0].metadata.profile.warmth, "warm", "profile should be unchanged");
      assert.strictEqual(afterRows[0].metadata.profile.humor, "light", "profile should be unchanged");
    } finally {
      cleanup();
    }
  });

  test("re-onboarding preserves profile fields not explicitly changed", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: AMBIENT_ROLLOUT,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      const loreOnboard = buildLoreOnboardTool(db, config);

      // Initial onboarding with specific profile
      await loreOnboard.handler({
        userName: "Matt",
        warmth: "warm",
        humor: "light",
        humorFrequency: "frequent",
        voice: "friendly",
      }, {
        sessionId: "session-onboard-1",
      });

      // Re-onboard changing only warmth
      await loreOnboard.handler({
        warmth: "balanced",
      }, {
        sessionId: "session-onboard-2",
      });

      const activeStyles = db.searchSemantic({
        query: "",
        repository: null,
        includeOtherRepositories: false,
        types: ["interaction_style"],
        scopes: ["global"],
        limit: 20,
      });

      assert.strictEqual(activeStyles.length, 1, "only one active interaction_style row should remain");
      assert.strictEqual(activeStyles[0].metadata.profile.warmth, "balanced", "warmth should be updated");
      assert.strictEqual(activeStyles[0].metadata.profile.voice, "friendly", "voice should be preserved");
      assert.strictEqual(activeStyles[0].metadata.profile.humor, "light", "humor should be preserved");
      assert.strictEqual(activeStyles[0].metadata.profile.humorFrequency, "frequent", "humorFrequency should be preserved");
    } finally {
      cleanup();
    }
  });

  test("re-onboarding changes only assistant_identity when assistantName is provided", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: AMBIENT_ROLLOUT,
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      const loreOnboard = buildLoreOnboardTool(db, config);

      // Initial onboarding
      await loreOnboard.handler({
        userName: "Matt",
        warmth: "warm",
        humor: "light",
      }, {
        sessionId: "session-onboard-1",
      });

      const beforeStyleRows = db.searchSemantic({
        query: "",
        repository: null,
        includeOtherRepositories: false,
        types: ["interaction_style"],
        scopes: ["global"],
        limit: 20,
      });
      const beforeStyleRowId = beforeStyleRows[0].id;
      const beforeStyleUpdatedAt = beforeStyleRows[0].updated_at;

      // Re-onboard changing only assistantName
      await loreOnboard.handler({
        assistantName: "Custom",
      }, {
        sessionId: "session-onboard-2",
      });

      const afterStyleRows = db.searchSemantic({
        query: "",
        repository: null,
        includeOtherRepositories: false,
        types: ["interaction_style"],
        scopes: ["global"],
        limit: 20,
      });

      // The style row should remain unchanged
      assert.strictEqual(afterStyleRows.length, 1, "only one active interaction_style row should remain");
      assert.strictEqual(afterStyleRows[0].id, beforeStyleRowId, "style row ID should not change");
      assert.strictEqual(afterStyleRows[0].updated_at, beforeStyleUpdatedAt, "style row updated_at should not change");
    } finally {
      cleanup();
    }
  });
});
