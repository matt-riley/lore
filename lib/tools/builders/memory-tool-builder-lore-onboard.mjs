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
