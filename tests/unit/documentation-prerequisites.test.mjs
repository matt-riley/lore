import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkRuntime } from "../../lib/core/runtime.mjs";

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const root = JSON.parse(read("package.json"));
const website = JSON.parse(read("website/package.json"));
const prerequisiteDocs = [
  ["AGENTS.md", "website/package.json"],
  ["README.md", "website/package.json"],
  ["website/README.md", "package.json"],
  ["website/src/content/docs/contributing.md", "package.json"],
];

test("runtime, website, and contributor guides agree on supported prerequisites", async () => {
  assert.equal(website.engines.node, root.engines.node);
  const minimum = root.engines.node.match(/^>=(\d+\.\d+\.\d+)$/u)?.[1];
  assert.ok(minimum, "declare an explicit minimum Node version");
  const manager = root.packageManager.split("+")[0];
  assert.equal(website.packageManager.split("+")[0], manager);
  assert.match(manager, /^pnpm@\d+\.\d+\.\d+$/u, "pin an explicit pnpm version");
  const probe = await checkRuntime({
    version: minimum,
    loadSqlite: async () => ({ DatabaseSync: class { exec() {} close() {} } }),
  });
  assert.equal(probe.ok, true, "the supported minimum must pass runtime preflight");
  for (const [file, source] of prerequisiteDocs) {
    const text = read(file);
    assert.match(text, /Node(?:\.js)?/u, `${file} must document Node.js`);
    assert.match(text, /pnpm/u, `${file} must document pnpm`);
    assert.ok(text.includes(source), `${file} must point to ${source}`);
  }
});
