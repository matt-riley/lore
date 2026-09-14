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
 * per-request extras. Flipped 2026-09-14 on real-host evidence (issue #161):
 * GitHub Copilot CLI 1.0.83 loaded the lore extension in a non-interactive
 * `-p` session and the prompt intercept received `/lore` — a `/lore status`
 * run dispatched the status report, and an invalid verb logged the exact
 * LORE_SLASH_USAGE response. Legacy names remain input aliases for `/lore`
 * and `lore tool`; re-check on a new CLI major before changing this again.
 */
export const COPILOT_MODEL_LIST_SHRINK_READY = true;

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
