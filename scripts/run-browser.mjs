#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { USER_CONFIG_DEFAULTS } from "../lib/config.mjs";
import { LoreDb } from "../lib/db.mjs";
import { startLoreBrowserServer } from "../browser/server.mjs";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeDeep(base[key], value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

const ALLOWED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function normalizeLoopbackHost(value) {
  const host = String(value ?? "").trim().toLowerCase();
  if (!ALLOWED_LOOPBACK_HOSTS.has(host)) {
    throw new Error("host must be loopback-only: 127.0.0.1, localhost, or ::1");
  }
  return host;
}

function resolveArgPath(value) {
  return path.resolve(process.cwd(), String(value ?? ""));
}

function consumeBrowserArg(args, key, value, transform = (next) => next) {
  args[key] = transform(value);
  return true;
}

const BROWSER_ARG_HANDLERS = Object.freeze({
  "--host": (args, value) => consumeBrowserArg(args, "host", value, normalizeLoopbackHost),
  "--port": (args, value) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      args.port = Math.max(1, Math.min(65535, Math.round(parsed)));
    }
    return true;
  },
  "--repository": (args, value) => consumeBrowserArg(
    args,
    "repository",
    value,
    (next) => {
      const normalized = String(next ?? "").trim();
      return normalized.length > 0 ? normalized : null;
    },
  ),
  "--config": (args, value) => consumeBrowserArg(args, "configPath", value, resolveArgPath),
  "--derived-store-path": (args, value) => consumeBrowserArg(args, "derivedStorePath", value, resolveArgPath),
  "--backup-dir": (args, value) => consumeBrowserArg(args, "backupDir", value, resolveArgPath),
  "--raw-store-path": (args, value) => consumeBrowserArg(args, "rawStorePath", value, resolveArgPath),
});

export function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 43111,
    repository: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const handler = BROWSER_ARG_HANDLERS[argv[index]];
    if (!handler) {
      continue;
    }
    if (handler(args, argv[index + 1]) === true) {
      index += 1;
    }
  }

  return args;
}

function loadFileConfig(configPath) {
  if (!configPath || !existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function buildConfig(args) {
  // LORE_CONFIG env var provides a portable default config path that does
  // not depend on the working directory, useful for test fixtures and CI.
  const envConfigPath = process.env.LORE_CONFIG?.trim() || null;
  const envCopilotHome = process.env.LORE_COPILOT_HOME?.trim() || null;
  const defaultConfigPath = envConfigPath
    ?? (envCopilotHome ? path.join(envCopilotHome, "lore.json") : null)
    ?? path.resolve(process.cwd(), "lore.json");
  const fileConfig = loadFileConfig(args.configPath ?? defaultConfigPath);
  if (isPlainObject(fileConfig.maintenance) && !isPlainObject(fileConfig.maintenanceScheduler)) {
    fileConfig.maintenanceScheduler = fileConfig.maintenance;
  }
  const merged = mergeDeep(USER_CONFIG_DEFAULTS, fileConfig);

  return {
    ...merged,
    paths: {
      ...merged.paths,
      rawStorePath: args.rawStorePath ?? merged.paths.rawStorePath,
      derivedStorePath: args.derivedStorePath ?? merged.paths.derivedStorePath,
      backupDir: args.backupDir ?? merged.paths.backupDir,
    },
    configPath: args.configPath ?? (existsSync(defaultConfigPath) ? defaultConfigPath : "(defaults)"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = buildConfig(args);
  const db = new LoreDb(config);
  db.initialize();

  const { server, host, port } = startLoreBrowserServer({
    db,
    host: args.host,
    port: args.port,
    repository: args.repository,
  });

  const localUrl = `http://${host}:${port}`;
  console.log(`[lore-browser] local read-only server started at ${localUrl}`);
  console.log(`[lore-browser] using database ${config.paths.derivedStorePath}`);
  console.log("[lore-browser] press Ctrl+C to stop");

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
