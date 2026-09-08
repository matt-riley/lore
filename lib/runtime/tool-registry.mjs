import { LORE_CAPABILITY_SPECS } from "../capabilities/capability-manifest.mjs";
import { createMemoryTools } from "../tools/memory-tools.mjs";

/** Intended default model list on every host after the Copilot /lore merge gate. */
export const DEFAULT_MODEL_TOOL_NAMES = Object.freeze([
  "lore_recall",
  "lore_retain",
  "lore_forget",
  "lore_status",
  "lore_onboard",
  "lore_search",
  "lore_explain",
  "lore_validate",
  "lore_correct",
]);

/**
 * Mocked joinSession tests are required but not sufficient to shrink Copilot's
 * per-request extras. Flip only after /lore status appears in the observed CLI
 * TUI picker or the prompt intercept is shown to receive /lore on that CLI.
 */
export const COPILOT_MODEL_LIST_SHRINK_READY = false;

export function listModelTools({ getRuntime } = {}) {
  const tools = createMemoryTools({ getRuntime });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return DEFAULT_MODEL_TOOL_NAMES.map((name) => byName.get(name)).filter(Boolean);
}

export function listRegisteredTools({ getRuntime } = {}) {
  return createMemoryTools({ getRuntime });
}

export function listCopilotJoinTools({ getRuntime } = {}) {
  return COPILOT_MODEL_LIST_SHRINK_READY
    ? listModelTools({ getRuntime })
    : listRegisteredTools({ getRuntime });
}

export function listSlashToolNames() {
  return LORE_CAPABILITY_SPECS
    .filter((spec) => spec.surfaces.slash === true)
    .map((spec) => spec.name);
}
