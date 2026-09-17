#!/usr/bin/env node
/**
 * Preview TypeSafe recall reranking for a single prompt.
 *
 * Runs prompt recall twice against the local store — baseline (rerank off) and
 * rerank (TypeSafe on) — and prints both shortlists with Jev's usefulness
 * scores, so the effect can be judged on real memories before enabling rerank
 * in the Lore config.
 *
 * Usage:
 *   LORE_TYPESAFE_API_KEY=... node scripts/rerank-preview.mjs --prompt "..." [--repository <id>] [--limit 6]
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  COMMON_PATH_ARG_HANDLERS,
  finalizeScriptConfig,
  parseArgsWith,
  resolveDefaultLoreConfigPath,
} from "./shared-args.mjs";
import { USER_CONFIG_DEFAULTS, loadFileConfigSync, mergeDeep } from "../lib/core/config.mjs";
import { LoreDb } from "../lib/db/db.mjs";
import { assembleRecall } from "../lib/context/recall-assembler.mjs";
import { resolveRepositoryIdentity } from "../lib/utils/repository-identity.mjs";
import { TYPESAFE_API_KEY_ENV } from "../lib/inference/typesafe-rerank.mjs";

const ARG_HANDLERS = Object.freeze({
  "--prompt": { key: "prompt", transform: (value) => String(value ?? "") },
  "--limit": { key: "limit", transform: (value) => Number(value) },
  "--help": { assign: { help: true } },
  "-h": { assign: { help: true } },
  ...COMMON_PATH_ARG_HANDLERS,
});

function renderHelp() {
  return [
    "Usage:",
    "  LORE_TYPESAFE_API_KEY=... node scripts/rerank-preview.mjs --prompt \"<prompt>\" [options]",
    "",
    "Options:",
    "  --prompt <text>       Prompt to preview recall for (required).",
    "  --repository <id>     Repository identity to scope recall to.",
    "  --limit <n>           Shortlist size (default: limits.promptContextLimit).",
    "  --config <path>       Lore config path (default: the Lore home config).",
    "  --derived-store-path <path>, --raw-store-path <path>, --backup-dir <path>",
    "  -h, --help            Show this help.",
    "",
    `The key is read from ${TYPESAFE_API_KEY_ENV} or typesafe.apiKey in the config.`,
    "The preview does not write memories; recall may refresh the embedding cache while searching.",
  ].join("\n");
}

function buildConfig(args) {
  const defaultConfigPath = resolveDefaultLoreConfigPath();
  const fileConfig = loadFileConfigSync(args.configPath ?? defaultConfigPath);
  const merged = mergeDeep(USER_CONFIG_DEFAULTS, fileConfig);
  const configPath = args.configPath ?? (existsSync(defaultConfigPath) ? defaultConfigPath : "(defaults)");
  return finalizeScriptConfig(merged, args, configPath);
}

function resolveRepository(args) {
  if (args.repository) {
    return args.repository;
  }
  try {
    return resolveRepositoryIdentity({ cwd: process.cwd() }) ?? null;
  } catch {
    return null;
  }
}

function localMemoryRows(result) {
  const lookup = result?.trace?.lookups?.localMemories ?? {};
  return Array.isArray(lookup.includedRows) && lookup.includedRows.length > 0
    ? lookup.includedRows
    : (Array.isArray(lookup.rows) ? lookup.rows : []);
}

function formatRows(rows, { scores = null } = {}) {
  if (rows.length === 0) {
    return ["  (no memories matched)"];
  }
  return rows.map((row, index) => {
    const score = scores?.get(row.id);
    const scoreText = score && score.score !== null
      ? ` score=${Number(score.score).toFixed(2)}`
      : "";
    const confidenceText = score?.confidence != null
      ? ` conf=${Number(score.confidence).toFixed(2)}`
      : "";
    const content = String(row.content ?? "").replace(/\s+/g, " ");
    return `  ${index + 1}. [${row.type ?? "memory"}]${scoreText}${confidenceText} ${content}`;
  });
}

function formatMoves(baselineRows, rerankedRows) {
  const before = new Map(baselineRows.map((row, index) => [row.id, index + 1]));
  const after = new Map(rerankedRows.map((row, index) => [row.id, index + 1]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  const lines = [];
  for (const id of ids) {
    const from = before.get(id);
    const to = after.get(id);
    const marker = from === to ? "=" : (to ?? Infinity) < (from ?? Infinity) ? "↑" : "↓";
    lines.push(`  ${marker} ${id}: ${from ?? "new"} → ${to ?? "dropped"}`);
  }
  return lines.length > 0 ? lines : ["  (none)"];
}

async function main() {
  const args = parseArgsWith(ARG_HANDLERS, { prompt: "", limit: 0, help: false }, process.argv.slice(2));
  if (args.help) {
    console.log(renderHelp());
    return;
  }
  if (!args.prompt.trim()) {
    console.error(renderHelp());
    process.exitCode = 1;
    return;
  }

  const config = buildConfig(args);
  const apiKey = String(config.typesafe?.apiKey ?? "").trim()
    || String(process.env[TYPESAFE_API_KEY_ENV] ?? "").trim();
  if (!apiKey) {
    console.error(`No TypeSafe API key found. Set ${TYPESAFE_API_KEY_ENV} or typesafe.apiKey in ${config.configPath}.`);
    process.exitCode = 1;
    return;
  }

  const enabledTypesafe = {
    ...config.typesafe,
    enabled: true,
    rerank: { ...config.typesafe?.rerank, enabled: true },
  };
  const limit = Number.isInteger(args.limit) && args.limit > 0
    ? args.limit
    : Number(config.limits?.promptContextLimit) || 6;
  const repository = resolveRepository(args);

  const db = new LoreDb(config);
  db.initialize();
  try {
    const baseline = await assembleRecall({
      db,
      prompt: args.prompt,
      repository,
      limit,
      config: { ...config, typesafe: { ...config.typesafe, enabled: false } },
    });
    const reranked = await assembleRecall({
      db,
      prompt: args.prompt,
      repository,
      limit,
      config: { ...config, typesafe: enabledTypesafe },
    });

    const baselineRows = localMemoryRows(baseline);
    const rerankedRows = localMemoryRows(reranked);
    const rerank = reranked.trace?.lookups?.rerank ?? {};
    const scores = new Map((rerank.scores ?? []).map((entry) => [entry.id, entry]));

    const lines = [
      `prompt: ${args.prompt}`,
      `repository: ${repository ?? "(all)"}`,
      `limit: ${limit}`,
      "",
      `baseline (rerank off): ${baselineRows.length} memories, ~${baseline.estimatedTokens} tokens`,
      ...formatRows(baselineRows),
      "",
      `reranked (TypeSafe): ${rerankedRows.length} memories, ~${reranked.estimatedTokens} tokens`,
      `  reason: ${rerank.reason ?? "unknown"}${rerank.error ? ` (${rerank.error})` : ""}`,
      ...formatRows(rerankedRows, { scores }),
      "",
      "position changes:",
      ...formatMoves(baselineRows, rerankedRows),
    ];
    console.log(lines.join("\n"));

    if (rerank.reason !== "reranked") {
      console.error("\nRerank did not apply. Check the reason above, the key, typesafe.enabled, and typesafe.rerank.enabled.");
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
