export function buildMemoryCapabilityInventoryTool(_getRuntime, context) {
  const {
    toolDef,
    ensureLimit,
    normalizeCapabilityInventoryAction,
    renderCapabilityInventoryAction,
  } = context;
  return toolDef("memory_capability_inventory", {
    handler: async (args) => {
      const action = normalizeCapabilityInventoryAction(args.action);
      const limit = ensureLimit(args.limit, 5, 20);
      return renderCapabilityInventoryAction(args, limit, action);
    },
  });
}
