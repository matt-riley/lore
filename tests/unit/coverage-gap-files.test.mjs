import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { createAppRunner, createBrowserTestEnvironment, createDefaultFetch } from "../helpers/browser-dom.mjs";
import { makeSourceExtractor } from "../helpers/source-parser.mjs";

const runApp = createAppRunner();
const INDEX_HTML = readFileSync(new URL("../../browser/index.html", import.meta.url), "utf8");
const DEV_INSTALL_SOURCE = readFileSync(new URL("../../scripts/dev-install.mjs", import.meta.url), "utf8");
const VALIDATE_SCHEMA_SOURCE = readFileSync(new URL("../../scripts/validate-config-schema.mjs", import.meta.url), "utf8");
const extractDevInstallFunction = makeSourceExtractor(DEV_INSTALL_SOURCE);
const extractValidateFunction = makeSourceExtractor(VALIDATE_SCHEMA_SOURCE);

function loadDevInstallFunctions(names, dependencies = {}) {
  const functionSources = names.map((name) => extractDevInstallFunction(name)).join("\n\n");
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; ${functionSources}; return { ${names.join(", ")} };`,
  )(...Object.values(dependencies));
}

function loadValidateSchemaFunctions(names, dependencies = {}) {
  const functionSources = names.map((name) => extractValidateFunction(name)).join("\n\n");
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; ${functionSources}; return { ${names.join(", ")} };`,
  )(...Object.values(dependencies));
}

describe("browser/index.html", () => {
  test("defines Lore Browser shell structure and module entrypoint", () => {
    assert.match(INDEX_HTML, /<!doctype html>/i);
    assert.match(INDEX_HTML, /<title>Lore Browser<\/title>/);
    assert.match(INDEX_HTML, /<link rel="stylesheet" href="\/styles\.css" \/>/);
    assert.match(INDEX_HTML, /<script src="\/app\.js" type="module"><\/script>/);
    assert.match(INDEX_HTML, /data-tab="overview"/);
    assert.match(INDEX_HTML, /data-tab="drilldown"/);
    assert.match(INDEX_HTML, /id="view-overview"/);
    assert.match(INDEX_HTML, /id="view-drilldown"/);
  });
});

describe("browser/app.js", () => {
  test("renders initial overview status and scope in the browser harness", async () => {
    const { elements, document, history } = createBrowserTestEnvironment();
    const window = {
      location: {
        hash: "",
        pathname: "/browser",
        search: "",
      },
      listeners: new Map(),
      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      },
      requestAnimationFrame(callback) {
        callback();
        return 1;
      },
    };

    await runApp(document, window, createDefaultFetch(), history);

    assert.equal(elements.get("status-pill")?.textContent, "read-only local mode");
    assert.equal(elements.get("scope-pill")?.textContent, "scope: owner/repo");
    assert.match(elements.get("view-overview")?.innerHTML ?? "", /Semantic memories/);
    assert.match(elements.get("view-drilldown")?.innerHTML ?? "", /Focused drill-down/);
  });
});

describe("scripts/dev-install.mjs", () => {
  test("parseArgs reads dry-run and copilot home flags", () => {
    const { parseArgs } = loadDevInstallFunctions(["parseArgs"]);
    assert.deepStrictEqual(parseArgs([]), { dryRun: false, copilotHome: null });
    assert.deepStrictEqual(
      parseArgs(["--dry-run", "--copilot-home", "/tmp/copilot"]),
      { dryRun: true, copilotHome: "/tmp/copilot" },
    );
  });

  test("describeTarget classifies missing, symlink, directory, and other targets", () => {
    const { describeTarget } = loadDevInstallFunctions(
      ["describeTarget"],
      {
        existsSync(targetPath) {
          return targetPath !== "missing";
        },
        lstatSync(targetPath) {
          if (targetPath === "symlink") {
            return { isSymbolicLink: () => true, isDirectory: () => false };
          }
          if (targetPath === "directory") {
            return { isSymbolicLink: () => false, isDirectory: () => true };
          }
          return { isSymbolicLink: () => false, isDirectory: () => false };
        },
      },
    );

    assert.deepStrictEqual(describeTarget("missing"), { exists: false, type: "missing" });
    assert.deepStrictEqual(describeTarget("symlink"), { exists: true, type: "symlink" });
    assert.deepStrictEqual(describeTarget("directory"), { exists: true, type: "directory" });
    assert.deepStrictEqual(describeTarget("file"), { exists: true, type: "other" });
  });

  test("isSameInstall only returns true for matching real directory paths", () => {
    const { isSameInstall } = loadDevInstallFunctions(
      ["isSameInstall"],
      {
        existsSync(targetPath) {
          return targetPath !== "missing";
        },
        lstatSync(targetPath) {
          if (targetPath === "symlink") {
            return { isDirectory: () => true, isSymbolicLink: () => true };
          }
          if (targetPath === "file") {
            return { isDirectory: () => false, isSymbolicLink: () => false };
          }
          return { isDirectory: () => true, isSymbolicLink: () => false };
        },
        realpathSync(targetPath) {
          return targetPath === "different-target" ? "/real/b" : "/real/a";
        },
      },
    );

    assert.equal(isSameInstall("missing", "target"), false);
    assert.equal(isSameInstall("source", "missing"), false);
    assert.equal(isSameInstall("source", "symlink"), false);
    assert.equal(isSameInstall("source", "file"), false);
    assert.equal(isSameInstall("source", "different-target"), false);
    assert.equal(isSameInstall("source", "target"), true);
  });
});

describe("scripts/validate-config-schema.mjs", () => {
  test("collectConfigLeaves flattens nested config leaves", () => {
    const { isPlainObject, collectConfigLeaves } = loadValidateSchemaFunctions([
      "isPlainObject",
      "collectConfigLeaves",
    ]);
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);

    const leaves = collectConfigLeaves({
      enabled: true,
      rollout: {
        memoryDomains: false,
      },
      paths: {
        loreDb: "/tmp/lore.db",
      },
    });

    assert.deepStrictEqual(
      [...leaves.entries()],
      [
        ["enabled", true],
        ["rollout.memoryDomains", false],
        ["paths.loreDb", "/tmp/lore.db"],
      ],
    );
  });

  test("collectSchemaLeaves flattens schema properties and marks missing defaults", () => {
    const NO_DEFAULT = Symbol("NO_DEFAULT");
    const { collectSchemaLeaves } = loadValidateSchemaFunctions(
      [
        "isPlainObject",
        "collectSchemaLeaves",
      ],
      {
        NO_DEFAULT,
      },
    );

    const leaves = collectSchemaLeaves({
      properties: {
        $schema: { type: "string", default: "ignored" },
        enabled: { type: "boolean", default: true },
        rollout: {
          type: "object",
          properties: {
            memoryDomains: { type: "boolean", default: false },
            reviewGate: { type: "boolean" },
          },
        },
      },
    });

    assert.equal(leaves.get("enabled"), true);
    assert.equal(leaves.get("rollout.memoryDomains"), false);
    assert.equal(leaves.get("rollout.reviewGate"), NO_DEFAULT);
    assert.equal(leaves.has("$schema"), false);
  });
});
