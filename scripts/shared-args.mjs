import { parseArgs } from "node:util";
import { resolveLorePaths } from "../lib/core/lore-paths.mjs";
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

// Strict, schema-driven parsing: unknown flags, missing values, option-like
// values, and stray positionals all fail before any storage is opened.
export function parseArgsWith(handlers, defaults, argv) {
  const options = {};
  const valueHandlers = new Map();
  for (const [flag, handler] of Object.entries(handlers)) {
    const name = flag.replace(/^--?/, "");
    options[name] = { type: handler.key ? "string" : "boolean" };
    valueHandlers.set(name, handler);
  }
  const parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: false });
  const args = { ...defaults };
  for (const [name, handler] of valueHandlers) {
    const value = parsed.values[name];
    if (handler.assign && value === true) {
      Object.assign(args, handler.assign);
    }
    if (handler.key && value !== undefined) {
      args[handler.key] = handler.transform ? handler.transform(value, args) : value;
    }
  }
  return args;
}
