#!/usr/bin/env node

import { existsSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { USER_CONFIG_DEFAULTS, isPlainObject, mergeDeep, loadFileConfigSync } from "../lib/config.mjs";
export { mergeDeep };
import { LoreDb } from "../lib/db.mjs";
import { startLoreBrowserServer } from "../browser/server.mjs";
import { COMMON_PATH_ARG_HANDLERS, parseArgsWith, resolveDefaultLoreConfigPath, finalizeScriptConfig } from "./shared-args.mjs";

const ALLOWED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function normalizeLoopbackHost(value) {
  const host = String(value ?? "").trim().toLowerCase();
  if (!ALLOWED_LOOPBACK_HOSTS.has(host)) {
    throw new Error("host must be loopback-only: 127.0.0.1, localhost, or ::1");
  }
  return host;
}

function normalizePort(value, args) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(65535, Math.round(parsed)))
    : args.port;
}

const BROWSER_ARG_HANDLERS = Object.freeze({
  "--host": { key: "host", transform: normalizeLoopbackHost },
  "--port": { key: "port", transform: normalizePort },
  ...COMMON_PATH_ARG_HANDLERS,
});

export function parseArgs(argv) {
  return parseArgsWith(BROWSER_ARG_HANDLERS, { host: "127.0.0.1", port: 43111, repository: null }, argv);
}

function applyMaintenanceCompatibility(fileConfig) {
  if (!isPlainObject(fileConfig)) {
    return {};
  }
  if (isPlainObject(fileConfig.maintenance) && !isPlainObject(fileConfig.maintenanceScheduler)) {
    return {
      ...fileConfig,
      maintenanceScheduler: fileConfig.maintenance,
    };
  }
  return fileConfig;
}

function resolveRuntimeConfigPath(argsConfigPath, defaultConfigPath) {
  if (typeof argsConfigPath === "string" && argsConfigPath.trim().length > 0) {
    return argsConfigPath;
  }
  if (existsSync(defaultConfigPath)) {
    return defaultConfigPath;
  }
  return "(defaults)";
}

export function buildConfig(args) {
  // LORE_CONFIG env var provides a portable default config path that does
  // not depend on the working directory, useful for test fixtures and CI.
  const defaultConfigPath = resolveDefaultLoreConfigPath();
  const requestedConfigPath = args.configPath ?? defaultConfigPath;
  const fileConfig = applyMaintenanceCompatibility(loadFileConfigSync(requestedConfigPath));
  const merged = mergeDeep(USER_CONFIG_DEFAULTS, fileConfig);
  return finalizeScriptConfig(merged, args, resolveRuntimeConfigPath(args.configPath, defaultConfigPath));
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

  try {
    await once(server, "listening");
  } catch (error) {
    db.close();
    throw error;
  }
  const localUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
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
