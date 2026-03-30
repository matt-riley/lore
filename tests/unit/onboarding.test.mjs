import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createMemoryTools } from "../../lib/memory-tools.mjs";
import {
  buildOnboardingMemories,
  buildOnboardingSection,
  readOnboardingState,
  resolveOnboardingInput,
  seedOnboardingMemories,
} from "../../lib/onboarding.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE && "FTS5 not available in this Node build";

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
        rollout: {
          memoryOperations: true,
          workstreamOverlays: true,
          temporalQueryNormalization: true,
          retentionSanitization: true,
          directives: true,
          hybridRetrieval: true,
        },
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
        rollout: {
          memoryOperations: true,
          workstreamOverlays: true,
          temporalQueryNormalization: true,
          retentionSanitization: true,
          directives: true,
          hybridRetrieval: true,
        },
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
        rollout: {
          memoryOperations: true,
          workstreamOverlays: true,
          temporalQueryNormalization: true,
          retentionSanitization: true,
          directives: true,
          hybridRetrieval: true,
        },
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
        rollout: {
          memoryOperations: true,
          workstreamOverlays: true,
          temporalQueryNormalization: true,
          retentionSanitization: true,
          directives: true,
          hybridRetrieval: true,
        },
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
});

describe("lore_onboard tool", () => {
  test("persists the user's preferred name and explicit style overrides", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          ambientPersonaMode: true,
          memoryOperations: true,
          workstreamOverlays: true,
          temporalQueryNormalization: true,
          retentionSanitization: true,
          directives: true,
          hybridRetrieval: true,
        },
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      const runtime = {
        initialized: true,
        lastError: null,
        db,
        config,
        repository: "fixture-repo",
        sessionStore: null,
      };
      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const loreOnboard = tools.find((tool) => tool.name === "lore_onboard");
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
        rollout: {
          ambientPersonaMode: true,
          memoryOperations: true,
          workstreamOverlays: true,
          temporalQueryNormalization: true,
          retentionSanitization: true,
          directives: true,
          hybridRetrieval: true,
        },
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

      const runtime = {
        initialized: true,
        lastError: null,
        db,
        config,
        repository: "fixture-repo",
        sessionStore: null,
      };
      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const loreOnboard = tools.find((tool) => tool.name === "lore_onboard");

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
        rollout: {
          ambientPersonaMode: true,
          memoryOperations: true,
          workstreamOverlays: true,
          temporalQueryNormalization: true,
          retentionSanitization: true,
          directives: true,
          hybridRetrieval: true,
        },
      },
    });

    try {
      seedOnboardingMemories({
        db,
        sessionId: "session-seed",
      });

      const runtime = {
        initialized: true,
        lastError: null,
        db,
        config,
        repository: "fixture-repo",
        sessionStore: null,
      };
      const tools = createMemoryTools({
        getRuntime: async () => runtime,
      });
      const loreOnboard = tools.find((tool) => tool.name === "lore_onboard");
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
});
