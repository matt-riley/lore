// Coverage for the daemon's JS proofs: Node's built-in coverage over the
// adapter clients, with the LCOV report written next to the root one so a
// change can be scored with `crap <path> --diff`.
//
// The proofs spawn the built binaries, so they are built first: a binary left
// in target/ by an older commit reads that commit's journal format, and the
// proofs would fail against code that is not under test. This mirrors the
// daemon job's Build binaries step.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const daemonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lored = path.join(daemonDir, "target/debug/lored");

const build = spawnSync("cargo", ["build"], { cwd: daemonDir, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const output = path.join(daemonDir, "..", "coverage");
mkdirSync(output, { recursive: true });

const args = [
  "--test",
  "--experimental-test-coverage",
  "--test-coverage-include=clients/**/*.mjs",
  "--test-coverage-exclude=tests/**",
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  "--test-reporter=lcov",
  `--test-reporter-destination=${path.join(output, "lcov-daemon.info")}`,
  "tests/two-client.test.mjs",
  "tests/lexical-quality.test.mjs",
  "tests/capability-catalog.test.mjs",
  "tests/adapter.test.mjs",
  "tests/host-adapters.test.mjs",
  "tests/packaging.test.mjs",
  "tests/endpoint-env.test.mjs",
  "tests/semantic-corpus.test.mjs",
  "tests/semantic-metrics.test.mjs",
];

const run = spawnSync(process.execPath, args, {
  cwd: daemonDir,
  stdio: "inherit",
  env: { ...process.env, LORED_BIN: lored },
});
process.exit(run.status ?? 1);
