function formatLoreUnavailable(runtime) {
  if (runtime.initialized && !runtime.lastError) {
    return null;
  }
  return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
}

export {
  formatLoreUnavailable,
};
