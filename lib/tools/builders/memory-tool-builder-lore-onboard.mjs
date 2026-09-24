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
      const hasOnboardingFields = hasProvidedOnboardingFields(args);

      // First-time onboarding still needs the user's name. Once Lore knows
      // it, an empty call can fill in any missing default assistant/style rows.
      if (!hasOnboardingFields && !onboardingState.userName) {
        return formatOnboardingNoChange();
      }

      const built = resolveOnboardingInput(buildOnboardingInputArgs(args, onboardingState, invocation.sessionId));
      const changedTypes = determineChangedTypes(args, built, onboardingState);

      if (!hasOnboardingFields && changedTypes.length === 0) {
        return formatOnboardingNoChange();
      }

      // Only persist changes if something actually changed
      if (changedTypes.length > 0) {
        persistOnboardingMemories(runtime.db, built.memories, changedTypes);
      }

      return formatOnboardingResult(args, built);
    },
  });
}
