import path from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeRepository(repository) {
  return typeof repository === "string" && repository.trim().length > 0
    ? repository.trim()
    : null;
}

export function resolveCopilotRoot(config, moduleUrl) {
  const configuredRoot = config?.paths?.copilotHome;
  if (typeof configuredRoot === "string" && configuredRoot.trim().length > 0) {
    return path.resolve(configuredRoot);
  }
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..", "..");
}
