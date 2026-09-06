import { createRolloutBooleanReader } from "./rollout-flag-utils.mjs";

// Both Phase 3 flags default to false — strictly opt-in.
const readSubagentScopeTrackingEnabled = createRolloutBooleanReader("subagentScopeTracking", false);
const readPreToolUseGuardrailEnabled = createRolloutBooleanReader("preToolUseGuardrail", false);

export { readSubagentScopeTrackingEnabled, readPreToolUseGuardrailEnabled };
