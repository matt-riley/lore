import { ensureArray } from "./memory-tools-array-utils.mjs";

export function formatActivityStates(states) {
  if (ensureArray(states).length === 0) {
    return ["- none"];
  }
  return ensureArray(states).map((state) => formatActivityState(state));
}

// fallow-ignore-next-line complexity
function formatActivityState(state) {
  const sections = ensureArray(state.lastContextInjectionSections).join(", ") || "none";
  return [
    `- [${state.scopeKey}] scope=${state.scopeType}`,
    state.repository ? `repository=${state.repository}` : null,
    `lastContextInjectionAt=${state.lastContextInjectionAt ?? "none"}`,
    `lastContextHook=${state.lastContextInjectionHook ?? "none"}`,
    `lastContextSections=${sections}`,
    `lastExtractionCompletionAt=${state.lastExtractionCompletionAt ?? "none"}`,
    `lastMaintenanceCompletionAt=${state.lastMaintenanceCompletionAt ?? "none"}`,
    `lastMaintenanceStatus=${state.lastMaintenanceStatus ?? "none"}`,
    `lastTraceRecordedAt=${state.lastTraceRecordedAt ?? "none"}`,
    `lastTraceHook=${state.lastTraceHook ?? "none"}`,
    `updatedAt=${state.updatedAt ?? "none"}`,
  ].filter(Boolean).join(" ");
}
