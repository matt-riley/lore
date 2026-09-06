import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_MODULE = pathToFileURL(path.join(REPO_ROOT, "lib/config.mjs")).href;
const BROWSER_MODULE = pathToFileURL(path.join(REPO_ROOT, "scripts/run-browser.mjs")).href;

function makeTempHome() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-paths-smoke-"));
}

function isolatedEnv(home, overrides = {}) {
  const env = { ...process.env, HOME: home, NODE_NO_WARNINGS: "1", ...overrides };
  for (const key of ["LORE_HOME", "LORE_CONFIG", "LORE_COPILOT_HOME", "XDG_CONFIG_HOME"]) {
    if (!(key in overrides)) {
      delete env[key];
    }
  }
  return env;
}

function probe(home, source, { cwd = REPO_ROOT, env = {} } = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd,
    env: isolatedEnv(home, env),
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, `probe failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function probeBoth(home, options = {}) {
  const runtime = probe(
    home,
    `const { loadConfig } = await import(${JSON.stringify(CONFIG_MODULE)}); console.log(JSON.stringify(await loadConfig()));`,
    options,
  );
  const browser = probe(
    home,
    `const { buildConfig, parseArgs } = await import(${JSON.stringify(BROWSER_MODULE)}); console.log(JSON.stringify(buildConfig(parseArgs([]))));`,
    options,
  );
  return { runtime, browser };
}

function relevant(config) {
  return {
    enabled: config.enabled,
    paths: config.paths,
  };
}

test("fresh defaults use ~/.config/lore while keeping CopilotHome separate", () => {
  const home = makeTempHome();
  try {
    const { runtime, browser } = probeBoth(home);
    const expectedHome = path.join(home, ".config", "lore");
    assert.deepEqual(relevant(runtime), relevant(browser));
    assert.equal(runtime.configPath, path.join(expectedHome, "lore.json"));
    assert.equal(runtime.paths.copilotHome, path.join(home, ".copilot"));
    assert.equal(runtime.paths.derivedStorePath, path.join(expectedHome, "lore.db"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("absolute XDG_CONFIG_HOME and explicit LORE_HOME relocate the Lore home", () => {
  const home = makeTempHome();
  try {
    const xdg = path.join(home, "xdg");
    const xdgResult = probeBoth(home, { env: { XDG_CONFIG_HOME: xdg } });
    assert.deepEqual(relevant(xdgResult.runtime), relevant(xdgResult.browser));
    assert.equal(xdgResult.runtime.paths.derivedStorePath, path.join(xdg, "lore", "lore.db"));

    const explicit = path.join(home, "explicit-lore");
    const explicitResult = probeBoth(home, { env: { LORE_HOME: explicit, LORE_COPILOT_HOME: path.join(home, "copilot") } });
    assert.deepEqual(relevant(explicitResult.runtime), relevant(explicitResult.browser));
    assert.equal(explicitResult.runtime.paths.derivedStorePath, path.join(explicit, "lore.db"));
    assert.equal(explicitResult.runtime.paths.copilotHome, path.join(home, "copilot"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("filename-only LORE_CONFIG and file path overrides are retained by both entrypoints", () => {
  const home = makeTempHome();
  const cwd = path.join(home, "cwd");
  mkdirSync(cwd);
  writeFileSync(path.join(cwd, "custom.json"), JSON.stringify({
    enabled: true,
    paths: {
      rawStorePath: "/fixture/raw.db",
      derivedStorePath: "/fixture/derived.db",
      backupDir: "/fixture/backups",
    },
  }));
  try {
    const { runtime, browser } = probeBoth(home, { cwd, env: { LORE_CONFIG: "custom.json" } });
    assert.equal(runtime.configPath, "custom.json");
    assert.equal(browser.configPath, "custom.json");
    assert.deepEqual(relevant(runtime), relevant(browser));
    assert.equal(runtime.enabled, true);
    assert.equal(runtime.paths.rawStorePath, "/fixture/raw.db");
    assert.equal(runtime.paths.derivedStorePath, "/fixture/derived.db");
    assert.equal(runtime.paths.backupDir, "/fixture/backups");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy Copilot config and database fall back only when the new home is absent", () => {
  const home = makeTempHome();
  const copilot = path.join(home, ".copilot");
  mkdirSync(copilot);
  writeFileSync(path.join(copilot, "lore.json"), JSON.stringify({ enabled: true }));
  try {
    const legacy = probeBoth(home);
    assert.deepEqual(relevant(legacy.runtime), relevant(legacy.browser));
    assert.equal(legacy.runtime.configPath, path.join(copilot, "lore.json"));
    assert.equal(legacy.runtime.paths.derivedStorePath, path.join(copilot, "lore.db"));
    assert.equal(legacy.runtime.enabled, true);

    mkdirSync(path.join(home, ".config", "lore"), { recursive: true });
    const fresh = probeBoth(home);
    assert.deepEqual(relevant(fresh.runtime), relevant(fresh.browser));
    assert.equal(fresh.runtime.configPath, path.join(home, ".config", "lore", "lore.json"));
    assert.equal(fresh.runtime.paths.derivedStorePath, path.join(home, ".config", "lore", "lore.db"));
    assert.equal(fresh.runtime.enabled, false);

    rmSync(path.join(home, ".config", "lore"), { recursive: true, force: true });
    rmSync(path.join(copilot, "lore.json"), { force: true });
    writeFileSync(path.join(copilot, "lore.db"), "legacy database marker");
    const dbOnly = probeBoth(home);
    assert.deepEqual(relevant(dbOnly.runtime), relevant(dbOnly.browser));
    assert.equal(dbOnly.runtime.configPath, path.join(copilot, "lore.json"));
    assert.equal(dbOnly.runtime.paths.derivedStorePath, path.join(copilot, "lore.db"));
    assert.equal(dbOnly.runtime.paths.backupDir, path.join(copilot, "backups", "lore"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
