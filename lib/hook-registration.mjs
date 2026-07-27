export function buildLoreHooks(handlers = {}) {
  // Known/allowed hook names - keep conservative list of likely SDK hooks.
  const allowed = [
    "onPreToolUse",
    "onPostToolUse",
    "onUserPromptSubmitted",
    "onSessionStart",
    "onSessionEnd",
    "onErrorOccurred",
    "onEvent",
  ];

  const result = {};
  for (const name of allowed) {
    const v = handlers[name];
    if (typeof v === "function") {
      // Preserve original function identity; do not wrap.
      result[name] = v;
    }
  }
  return result;
}
