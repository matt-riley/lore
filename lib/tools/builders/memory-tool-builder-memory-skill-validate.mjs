export function buildMemorySkillValidateTool(getRuntime, context) {
  const {
    toolDef,
    withAvailableRuntime,
    validateSkillsDirectory,
    formatValidationResults,
  } = context;
  return toolDef("memory_skill_validate", {
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["summary", "detailed"],
          description: "Output format: 'summary' (default) or 'detailed'",
        },
      },
    },
    handler: withAvailableRuntime(getRuntime, async ({ args, runtime }) => {
      const rootPath = runtime.workspaceRoot || process.cwd();
      const action = args.action === "detailed" ? "detailed" : "summary";

      try {
        const result = await validateSkillsDirectory(rootPath);
        return formatValidationResults(result, action);
      } catch (error) {
        return `skill validation error: ${error?.message ?? "unknown error"}`;
      }
    }),
  });
}
