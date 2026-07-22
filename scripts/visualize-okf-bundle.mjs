#!/usr/bin/env node

import path from "node:path";
import { existsSync, statSync } from "node:fs";

import { readOkfBundle } from "../lib/okf-bundle-reader.mjs";
import { renderOkfVisualizerHtml, writeOkfVisualizerHtml } from "../lib/okf-bundle-visualizer.mjs";

const VALUE_ARGUMENTS = Object.freeze({
  "--bundle": "bundle",
  "--out": "out",
  "--name": "name",
});
const HELP_ARGUMENTS = new Set(["--help", "-h"]);

function parseArgs(argv) {
  const args = { bundle: null, out: null, name: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = VALUE_ARGUMENTS[arg];
    if (key) {
      args[key] = argv[index + 1];
      index += 1;
    } else if (HELP_ARGUMENTS.has(arg)) {
      args.help = true;
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/visualize-okf-bundle.mjs --bundle <dir> [--out <file>] [--name <label>]

Renders a self-contained HTML viewer for an Open Knowledge Format (OKF v0.1)
bundle -- a force-directed graph of concepts with a searchable detail panel,
backlinks, and type filter. Mirrors the "visualize" subcommand of the OKF
reference agent (GoogleCloudPlatform/knowledge-catalog okf/).

  --bundle <dir>   Path to the OKF bundle directory (must contain index.md). Required.
  --out <file>     Output HTML path. Defaults to <bundle>/viz.html.
  --name <label>   Display name shown in the viewer header. Defaults to the bundle directory name.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.bundle) {
    printUsage();
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const bundleDir = path.resolve(process.cwd(), args.bundle);
  if (!existsSync(bundleDir) || !statSync(bundleDir).isDirectory()) {
    console.error(`Bundle directory not found: ${bundleDir}`);
    process.exitCode = 1;
    return;
  }

  const bundle = await readOkfBundle(bundleDir);
  const html = renderOkfVisualizerHtml({ bundle, name: args.name });
  const outPath = args.out ? path.resolve(process.cwd(), args.out) : path.join(bundleDir, "viz.html");
  await writeOkfVisualizerHtml(outPath, html);

  console.log(`Wrote OKF bundle viewer: ${outPath}`);
  console.log(`  concepts: ${bundle.concepts.length}`);
  console.log(`  links: ${bundle.edges.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
