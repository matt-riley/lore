import { createRolloutBooleanReader } from "./rollout-flag-utils.mjs";

// Both passive hooks default to false so they are strictly opt-in.
const readErrorTelemetryEnabled = createRolloutBooleanReader("errorTelemetry", false);
const readPostToolUseEnabled = createRolloutBooleanReader("postToolUse", false);

export { readErrorTelemetryEnabled, readPostToolUseEnabled };
