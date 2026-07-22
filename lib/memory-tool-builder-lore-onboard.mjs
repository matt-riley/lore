export function buildLoreOnboardTool(getRuntime, context) {
  const {
    toolDef,
    formatLoreUnavailable,
    buildOnboardingInputArgs,
    persistOnboardingMemories,
    formatOnboardingResult,
    readOnboardingState,
    resolveOnboardingInput,
  } = context;
  return toolDef("lore_onboard", {
    parameters: {
      type: "object",
      properties: {
        userName: {
          type: "string",
          description: "The user's preferred name. Optional when Lore already knows it.",
        },
        assistantName: {
          type: "string",
          description: "Optional assistant self-name override; omitted means Lore chooses one during onboarding",
        },
        voice: {
          type: "string",
          enum: ["colleague", "collaborative", "friendly"],
          description: "Preferred assistant voice",
        },
        warmth: {
          type: "string",
          enum: ["warm", "balanced"],
          description: "Preferred assistant warmth",
        },
        humor: {
          type: "string",
          enum: ["light", "none"],
          description: "Whether Lore should use humor by default",
        },
        humorFrequency: {
          type: "string",
          enum: ["frequent", "occasional", "never"],
          description: "How often humor is welcome when humor is enabled",
        },
        collaborative: {
          type: "boolean",
          description: "Whether Lore should default to a collaborative teammate posture",
        },
        useNameNaturally: {
          type: "boolean",
          description: "Whether Lore should use the user's preferred name naturally when helpful",
        },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      const unavailable = formatLoreUnavailable(runtime);
      if (unavailable) {
        return unavailable;
      }
      const onboardingState = readOnboardingState({ db: runtime.db });
      const built = resolveOnboardingInput(buildOnboardingInputArgs(args, onboardingState, invocation.sessionId));
      persistOnboardingMemories(runtime.db, built.memories);
      return formatOnboardingResult(args, built);
    },
  });
}
