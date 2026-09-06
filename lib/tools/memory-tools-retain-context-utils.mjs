function normalizeRetainContext(args, runtime) {
  return {
    kind: args.kind === "workstream" ? "workstream" : "semantic",
    repository: typeof args.repository === "string" && args.repository.trim().length > 0
      ? args.repository.trim()
      : runtime.repository,
    scope: typeof args.scope === "string" ? args.scope.trim() : undefined,
    domainKey: typeof args.domainKey === "string" && args.domainKey.trim().length > 0
      ? args.domainKey.trim().toLowerCase()
      : null,
  };
}

export {
  normalizeRetainContext,
};
