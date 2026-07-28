export const LORE_HOOK_NAMES = Object.freeze([
  "onPreToolUse",
  "onPreMcpToolCall",
  "onPostToolUse",
  "onUserPromptSubmitted",
  "onSessionStart",
  "onSessionEnd",
  "onErrorOccurred",
]);

export function buildLoreHooks(handlers = {}) {
  const out = {};
  for (const name of LORE_HOOK_NAMES) {
    const h = handlers[name];
    if (typeof h === "function") {
      out[name] = h;
    }
  }
  return out;
}
