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

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 43111,
    repository: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === "--host") {
      args.host = normalizeLoopbackHost(argv[index + 1] ?? args.host);
      index += 1;
      continue;
    }
    if (part === "--port") {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed)) {
        args.port = Math.max(1, Math.min(65535, Math.round(parsed)));
      }
      index += 1;
      continue;
    }
    if (part === "--repository") {
      const value = String(argv[index + 1] ?? "").trim();
      args.repository = value.length > 0 ? value : null;
      index += 1;
      continue;
    }
    if (part === "--config") {
      args.configPath = path.resolve(process.cwd(), String(argv[index + 1] ?? ""));
      index += 1;
      continue;
    }
    if (part === "--derived-store-path") {
      args.derivedStorePath = path.resolve(process.cwd(), String(argv[index + 1] ?? ""));
      index += 1;
      continue;
    }
    if (part === "--backup-dir") {
      args.backupDir = path.resolve(process.cwd(), String(argv[index + 1] ?? ""));
      index += 1;
      continue;
    }
    if (part === "--raw-store-path") {
      args.rawStorePath = path.resolve(process.cwd(), String(argv[index + 1] ?? ""));
      index += 1;
      continue;
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
