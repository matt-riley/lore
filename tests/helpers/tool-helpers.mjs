import assert from "node:assert/strict";

export function findTool(tools, name) {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `expected ${name} tool`);
  return tool;
}

export function buildBackfillRuntime(db, config, { sessionStore } = {}) {
  return {
    initialized: true,
    lastError: null,
    db,
    config,
    repository: "fixture-repo",
    sessionStore: sessionStore ?? {
      getRecentSessions: () => [],
      getSessionArtifacts: () => null,
      getWorkspaceMetadata: () => null,
    },
    metrics: {
      sessionStart: null,
      userPromptSubmitted: null,
    },
    traceRecorder: null,
  };
}
