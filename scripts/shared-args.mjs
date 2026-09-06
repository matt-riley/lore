import { resolveLorePaths } from "../lib/lore-paths.mjs";
import path from "node:path";

function resolveArgPath(value) {
  return path.resolve(process.cwd(), String(value ?? ""));
}

function normalizeRepositoryArg(value) {
  return String(value ?? "").trim() || null;
}

export function resolveDefaultLoreConfigPath() {
  return resolveLorePaths().configPath;
}

export function finalizeScriptConfig(merged, args, configPath) {
  return {
    ...merged,
    paths: {
      ...merged.paths,
      rawStorePath: args.rawStorePath ?? merged.paths.rawStorePath,
      derivedStorePath: args.derivedStorePath ?? merged.paths.derivedStorePath,
      backupDir: args.backupDir ?? merged.paths.backupDir,
    },
    configPath,
  };
}

export const COMMON_PATH_ARG_HANDLERS = Object.freeze({
  "--config": { key: "configPath", transform: resolveArgPath },
  "--repository": { key: "repository", transform: normalizeRepositoryArg },
  "--derived-store-path": { key: "derivedStorePath", transform: resolveArgPath },
  "--backup-dir": { key: "backupDir", transform: resolveArgPath },
  "--raw-store-path": { key: "rawStorePath", transform: resolveArgPath },
});

export function parseArgsWith(handlers, defaults, argv) {
  const args = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const handler = handlers[argv[index]];
    if (!handler) {
      continue;
    }
    if (handler.assign) {
      Object.assign(args, handler.assign);
    }
    if (handler.key) {
      const value = argv[index + 1];
      args[handler.key] = handler.transform ? handler.transform(value, args) : value;
      index += 1;
    }
  }
  return args;
}
