/**
 * tests/unit/workflow-tooling.test.mjs
 *
 * Guards the CI contract from issue #154: maintenance checks must run tooling
 * pinned in the repository instead of resolving fresh packages at run time.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");

test("knip runs from the lockfile-managed dev dependency", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.knip, "knip");
  assert.equal(
    typeof pkg.devDependencies?.knip,
    "string",
    "knip must be a lockfile-managed dev dependency",
  );

  const lockfile = read("pnpm-lock.yaml");
  assert.match(lockfile, /^\s+knip@/m, "pnpm-lock.yaml must pin the installed knip version");

  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /run: npm run knip/);
  assert.doesNotMatch(ci, /npx --yes knip/);
});

test("workflow validation installs its Python dependency from a pinned requirements file", () => {
  const requirements = read(".github/requirements-validate-workflows.txt");
  assert.match(requirements, /^PyYAML==\d+\.\d+\.\d+$/m);

  const validateWorkflow = read(".github/workflows/validate-workflows.yml");
  assert.match(validateWorkflow, /--requirement \.github\/requirements-validate-workflows\.txt/);
  assert.doesNotMatch(validateWorkflow, /pip install[^\n]*pyyaml/i);
});
