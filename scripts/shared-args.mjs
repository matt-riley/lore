import path from "node:path";

function resolveArgPath(value) {
  return path.resolve(process.cwd(), String(value ?? ""));
}

export function consumeValueArg(args, key, value, transform = (next) => next) {
  args[key] = transform(value);
  return true;
}

export function resolveDefaultLoreConfigPath() {
  const configFromEnv = (process.env.LORE_CONFIG ?? "").trim();
  if (configFromEnv.length > 0) {
    return configFromEnv;
  }
  const homeFromEnv = (process.env.LORE_COPILOT_HOME ?? "").trim();
  if (homeFromEnv.length > 0) {
    return path.join(homeFromEnv, "lore.json");
  }
  return path.resolve(process.cwd(), "lore.json");
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
  "--config": (args, value) => consumeValueArg(args, "configPath", value, resolveArgPath),
  "--repository": (args, value) => consumeValueArg(args, "repository", value, (next) => String(next ?? "").trim() || null),
  "--derived-store-path": (args, value) => consumeValueArg(args, "derivedStorePath", value, resolveArgPath),
  "--backup-dir": (args, value) => consumeValueArg(args, "backupDir", value, resolveArgPath),
  "--raw-store-path": (args, value) => consumeValueArg(args, "rawStorePath", value, resolveArgPath),
});

export function parseArgsWith(handlers, defaults, argv) {
  const args = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const handler = handlers[argv[index]];
    if (!handler) {
      continue;
    }
    if (handler(args, argv[index + 1]) === true) {
      index += 1;
    }
  }
  return args;
}
