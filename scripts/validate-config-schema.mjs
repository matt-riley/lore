#!/usr/bin/env node
/**
 * validate-config-schema.mjs
 *
 * Compares USER_CONFIG_DEFAULTS in lib/config.mjs against the property
 * structure and defaults declared in schemas/coherence.schema.json at
 * leaf-property depth.
 *
 * Exits 0 on success, 1 on drift.
 *
 * paths.* leaves are exempt from default-value parity because their defaults
 * are computed from the user's home directory at runtime and are therefore
 * environment-specific.  Path parity (key presence) is still enforced for
 * paths.* — only the committed default values are skipped.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { USER_CONFIG_DEFAULTS } from "../lib/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_PATH = path.resolve(
  __dirname,
  "../schemas/coherence.schema.json",
);

const PATHS_PREFIX = "paths.";

const NO_DEFAULT = Symbol("NO_DEFAULT");

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collect all leaf paths from a nested plain object.
 * Returns a Map<dottedPath, leafValue>.
 */
function collectConfigLeaves(obj, prefix = "") {
  const result = new Map();
  for (const [key, value] of Object.entries(obj)) {
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      for (const [subPath, subValue] of collectConfigLeaves(value, dotPath)) {
        result.set(subPath, subValue);
      }
    } else {
      result.set(dotPath, value);
    }
  }
  return result;
}

/**
 * Walk JSON Schema "properties" recursively and collect all leaf paths.
 * Returns a Map<dottedPath, declaredDefault | NO_DEFAULT>.
 * The "$schema" meta-property is skipped because it is never in config defaults.
 */
function collectSchemaLeaves(schemaObj, prefix = "") {
  const result = new Map();
  if (!isPlainObject(schemaObj.properties)) {
    return result;
  }

  for (const [key, propSchema] of Object.entries(schemaObj.properties)) {
    if (key === "$schema") continue;

    const dotPath = prefix ? `${prefix}.${key}` : key;

    if (propSchema.type === "object" && isPlainObject(propSchema.properties)) {
      for (const [subPath, subValue] of collectSchemaLeaves(
        propSchema,
        dotPath,
      )) {
        result.set(subPath, subValue);
      }
    } else {
      result.set(
        dotPath,
        Object.prototype.hasOwnProperty.call(propSchema, "default")
          ? propSchema.default
          : NO_DEFAULT,
      );
    }
  }
  return result;
}

async function main() {
  const raw = await readFile(SCHEMA_PATH, "utf8");
  const schema = JSON.parse(raw);

  const configLeaves = collectConfigLeaves(USER_CONFIG_DEFAULTS);
  const schemaLeaves = collectSchemaLeaves(schema);

  const errors = [];

  // 1. Every config leaf must exist in the schema.
  for (const dotPath of configLeaves.keys()) {
    if (!schemaLeaves.has(dotPath)) {
      errors.push(`MISSING from schema: "${dotPath}"`);
    }
  }

  // 2. Every schema leaf must exist in the config defaults.
  for (const dotPath of schemaLeaves.keys()) {
    if (!configLeaves.has(dotPath)) {
      errors.push(`MISSING from config defaults: "${dotPath}"`);
    }
  }

  // 3. Default-value parity for non-paths.* leaves.
  for (const [dotPath, configValue] of configLeaves.entries()) {
    // paths.* defaults are environment-specific — exempt from value parity.
    if (dotPath.startsWith(PATHS_PREFIX)) continue;

    const schemaDefault = schemaLeaves.get(dotPath);
    // Missing key is already reported above; skip to avoid duplicate noise.
    if (schemaDefault === undefined) continue;

    if (schemaDefault === NO_DEFAULT) {
      errors.push(
        `MISSING default in schema for: "${dotPath}" (config default: ${JSON.stringify(configValue)})`,
      );
      continue;
    }

    if (schemaDefault !== configValue) {
      errors.push(
        `DEFAULT MISMATCH at "${dotPath}": schema=${JSON.stringify(schemaDefault)}, config=${JSON.stringify(configValue)}`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("Schema/config drift detected:\n");
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exit(1);
  }

  console.log("✓ Schema and config defaults are in parity.");
}

main().catch((err) => {
  console.error("Unexpected error:", err.message);
  process.exit(1);
});
