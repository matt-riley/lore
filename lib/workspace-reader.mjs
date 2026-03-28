import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

function parseSimpleYaml(text) {
  const result = {};
  for (const line of String(text || "").split("\n")) {
    if (!line.includes(":")) {
      continue;
    }
    const [key, ...rest] = line.split(":");
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      continue;
    }
    result[normalizedKey] = rest.join(":").trim();
  }
  return result;
}

// copilotHome is optional; pass config.paths.copilotHome when available so
// the fallback path respects LORE_COPILOT_HOME and any user override.
export function resolveWorkspacePath(workspacePath, sessionId, copilotHome) {
  if (typeof workspacePath === "string" && workspacePath.length > 0) {
    return workspacePath;
  }
  const home = copilotHome || path.join(os.homedir(), ".copilot");
  return path.join(home, "session-state", sessionId);
}

export async function readWorkspaceContext(workspacePath) {
  const workspaceFile = path.join(workspacePath, "workspace.yaml");
  const workspaceText = existsSync(workspaceFile) ? await readFile(workspaceFile, "utf8") : "";

  return {
    workspace: workspaceText ? parseSimpleYaml(workspaceText) : null,
  };
}
