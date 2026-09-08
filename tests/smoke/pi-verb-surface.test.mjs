import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HARNESS = path.join(REPO_ROOT, "tests", "fixtures", "pi-verb-surface-harness.mjs");
const LOADER = path.join(REPO_ROOT, "tests", "fixtures", "pi-adapter-loader.mjs");
const PI_SOURCE = readFileSync(path.join(REPO_ROOT, "lore-pi.ts"), "utf8");
const STRIP_TYPES_AVAILABLE = process.allowedNodeEnvironmentFlags.has("--experimental-strip-types");

describe("Pi verb surface", () => {
  test("registerCommand(lore) is a thin dispatchSlash wrapper and keeps lore_save", () => {
    assert.match(PI_SOURCE, /dispatchSlash\(/);
    assert.match(PI_SOURCE, /jsonSchemaToTypeBox\(/);
    assert.match(PI_SOURCE, /LORE_SLASH_DESCRIPTION/);
    assert.match(PI_SOURCE, /registerManifestTool\("lore_retain", "lore_save"\)/);
    assert.match(PI_SOURCE, /event: "session_start"/);
    assert.equal(PI_SOURCE.includes('description: "Inspect lore memory: status | search <query> | save <text>"'), false);
    assert.equal(/const \[cmd, \.\.\.rest\] = \(args \?\? ""\)\.trim\(\)\.split/.test(PI_SOURCE), false);
  });

  test("registers the nine model tools without rewriting serverPath", {
    skip: !STRIP_TYPES_AVAILABLE,
  }, () => {
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      "--experimental-loader",
      LOADER,
      HARNESS,
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(payload.ok, true);
    assert.equal(payload.tools.includes("lore_recall"), true);
    assert.equal(payload.tools.includes("lore_forget"), true);
    assert.equal(payload.tools.includes("lore_explain"), true);
    assert.equal(payload.tools.includes("lore_validate"), true);
    assert.equal(payload.tools.includes("lore_correct"), true);
    assert.equal(payload.tools.includes("lore_save"), true);
    assert.equal(payload.command, "lore");
    assert.equal(payload.serverPathRewritten, true);
  });
});
