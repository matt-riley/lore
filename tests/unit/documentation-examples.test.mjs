/**
 * tests/unit/documentation-examples.test.mjs
 *
 * Guards the onboarding examples from issue #142: the documented example
 * config must match the real file, and the canonical shell vocabulary must
 * actually run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");
const CLI = fileURLToPath(new URL("../../lore-cli.mjs", import.meta.url));

function isolatedHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-docs-example-"));
  const configPath = path.join(home, "lore.json");
  writeFileSync(configPath, JSON.stringify({ enabled: true }));
  const env = {
    ...process.env,
    HOME: home,
    LORE_HOME: home,
    LORE_CONFIG: configPath,
    LORE_ENABLED: "true",
    LORE_REPOSITORY: "docs/example",
  };
  delete env.LORE_CLIENT;
  return { home, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 15000 });
}

test("lore.example.json stays the minimal example the docs describe", () => {
  const example = JSON.parse(read("lore.example.json"));
  assert.deepEqual(Object.keys(example).sort(), ["$schema", "enabled"]);
  assert.equal(example.enabled, true);
  for (const file of ["README.md", "website/src/content/docs/getting-started.md"]) {
    const text = read(file);
    assert.doesNotMatch(
      text,
      /example[^.\n]*enables (?:the )?(?:session-start maintenance|maintenance scheduler|gradual archive import)/i,
      `${file} must not claim lore.example.json enables optional surfaces`,
    );
  }
});

test("the documented first-memory shell example runs end to end", () => {
  const { env, cleanup } = isolatedHome();
  try {
    const status = runCli(["status"], env);
    assert.equal(status.status, 0, status.stderr);

    const retain = runCli(["retain", "--type", "decision", "Use SQLite for this project"], env);
    assert.equal(retain.status, 0, retain.stderr);
    assert.match(retain.stdout, /Retained semantic memory/);

    const search = runCli(["search", "SQLite storage"], env);
    assert.equal(search.status, 0, search.stderr);
    assert.match(search.stdout, /Use SQLite for this project/);

    // The docs state the type is required; the old no-type shape must fail.
    const missingType = runCli(["retain", "No type supplied"], env);
    assert.notEqual(missingType.status, 0);
    assert.match(missingType.stderr, /type must be a non-empty string/);
  } finally {
    cleanup();
  }
});
