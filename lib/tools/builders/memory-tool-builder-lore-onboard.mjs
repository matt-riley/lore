export function buildLoreOnboardTool(getRuntime, context) {
  const {
    toolDef,
    formatLoreUnavailable,
    buildOnboardingInputArgs,
    persistOnboardingMemories,
    formatOnboardingResult,
    formatOnboardingNoChange,
    hasProvidedOnboardingFields,
    determineChangedTypes,
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

      // Check if any fields were provided for update
      if (!hasProvidedOnboardingFields(args)) {
        return formatOnboardingNoChange();
      }

      const built = resolveOnboardingInput(buildOnboardingInputArgs(args, onboardingState, invocation.sessionId));
      const changedTypes = determineChangedTypes(args, built, onboardingState);

      // Only persist changes if something actually changed
      if (changedTypes.length > 0) {
        persistOnboardingMemories(runtime.db, built.memories, changedTypes);
      }

      return formatOnboardingResult(args, built);
    },
  });
}
