import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkRuntime } from "../../lib/core/runtime.mjs";

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const root = JSON.parse(read("package.json"));
const website = JSON.parse(read("website/package.json"));

test("runtime, website, and contributor guides agree on supported prerequisites", async () => {
  assert.equal(website.engines.node, root.engines.node);
  const minimum = root.engines.node.match(/^>=(\d+\.\d+\.\d+)$/u)?.[1];
  assert.ok(minimum, "declare an explicit minimum Node version");
  const manager = root.packageManager.split("+")[0];
  assert.equal(website.packageManager.split("+")[0], manager);
  const pnpm = manager.match(/^pnpm@(\d+\.\d+\.\d+)$/u)?.[1];
  assert.ok(pnpm, "pin the package manager version");
  const probe = await checkRuntime({
    version: minimum,
    loadSqlite: async () => ({ DatabaseSync: class { exec() {} close() {} } }),
  });
  assert.equal(probe.ok, true, "the documented minimum must pass runtime preflight");
  for (const file of ["AGENTS.md", "README.md", "website/README.md", "website/src/content/docs/contributing.md"]) {
    const text = read(file);
    const nodeVersions = [...text.matchAll(/Node(?:\.js)?\s+(\d+\.\d+\.\d+)/gu)].map((match) => match[1]);
    const pnpmVersions = [...text.matchAll(/pnpm\s+(\d+\.\d+\.\d+)/gu)].map((match) => match[1]);
    assert.ok(nodeVersions.length > 0 && pnpmVersions.length > 0, `${file} must document both prerequisites`);
    assert.ok(nodeVersions.every((version) => version === minimum), `${file}: stale Node prerequisite`);
    assert.ok(pnpmVersions.every((version) => version === pnpm), `${file}: stale pnpm prerequisite`);
  }
  assert.ok(read("website/README.md").includes(`| \`PNPM_VERSION\` | \`${pnpm}\` |`));
});
