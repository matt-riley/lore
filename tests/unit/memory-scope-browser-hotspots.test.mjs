import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { buildSemanticCanonicalKey } from "../../lib/memory-scope.mjs";
import { buildConfig, mergeDeep, parseArgs } from "../../scripts/run-browser.mjs";

describe("run-browser parseArgs", () => {
  test("parses loopback host, clamped port, repository, and path overrides", () => {
    const args = parseArgs([
      "--host",
      " localhost ",
      "--port",
      "70000",
      "--repository",
      " owner/test-repo ",
      "--config",
      "./fixtures/lore.json",
      "--derived-store-path",
      "./fixtures/lore.db",
      "--backup-dir",
      "./fixtures/backups",
      "--raw-store-path",
      "./fixtures/session-store.db",
    ]);

    assert.deepEqual(args, {
      host: "localhost",
      port: 65535,
      repository: "owner/test-repo",
      configPath: path.resolve(process.cwd(), "./fixtures/lore.json"),
      derivedStorePath: path.resolve(process.cwd(), "./fixtures/lore.db"),
      backupDir: path.resolve(process.cwd(), "./fixtures/backups"),
      rawStorePath: path.resolve(process.cwd(), "./fixtures/session-store.db"),
    });
  });
});

describe("run-browser config helpers", () => {
  test("mergeDeep recursively merges plain objects without mutating the base value", () => {
    const base = {
      paths: {
        rawStorePath: "/tmp/raw.db",
        derivedStorePath: "/tmp/lore.db",
      },
      rollout: {
        reviewGate: false,
      },
    };
    const override = {
      paths: {
        derivedStorePath: "/tmp/override.db",
      },
      rollout: {
        reviewGate: true,
      },
      enabled: true,
    };

    const merged = mergeDeep(base, override);

    assert.deepEqual(merged, {
      paths: {
        rawStorePath: "/tmp/raw.db",
        derivedStorePath: "/tmp/override.db",
      },
      rollout: {
        reviewGate: true,
      },
      enabled: true,
    });
    assert.deepEqual(base, {
      paths: {
        rawStorePath: "/tmp/raw.db",
        derivedStorePath: "/tmp/lore.db",
      },
      rollout: {
        reviewGate: false,
      },
    });
  });

  test("buildConfig keeps maintenance compatibility and applies path overrides", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "lore-browser-config-"));
    const configPath = path.join(tempDir, "lore.json");
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          maintenance: {
            enabled: true,
            taskCadenceMinutes: {
              indexUpkeep: 15,
            },
          },
          paths: {
            derivedStorePath: "/tmp/from-file.db",
          },
        }),
        "utf8",
      );

      const config = buildConfig({
        configPath,
        rawStorePath: "/tmp/raw-override.db",
        derivedStorePath: "/tmp/derived-override.db",
        backupDir: "/tmp/backups-override",
      });

      assert.equal(config.enabled, true);
      assert.equal(config.maintenanceScheduler.enabled, true);
      assert.equal(config.maintenanceScheduler.taskCadenceMinutes.indexUpkeep, 15);
      assert.equal(config.paths.rawStorePath, "/tmp/raw-override.db");
      assert.equal(config.paths.derivedStorePath, "/tmp/derived-override.db");
      assert.equal(config.paths.backupDir, "/tmp/backups-override");
      assert.equal(config.configPath, configPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildSemanticCanonicalKey", () => {
  test("prefers metadata preferredName for user identity canonical keys", () => {
    assert.equal(
      buildSemanticCanonicalKey({
        type: "user_identity",
        content: "The user's preferred name is Chris.",
        metadata: {
          preferredName: "Matt",
        },
      }),
      "user_identity:matt",
    );
  });

  test("prefers overlay identifiers over title or content for workstream keys", () => {
    assert.equal(
      buildSemanticCanonicalKey({
        type: "workstream_overlay",
        content: "Fallback content",
        metadata: {
          overlayId: "retrieval-hotspots",
          id: "ignored-id",
          title: "Ignored Title",
        },
      }),
      "workstream_overlay:retrieval-hotspots",
    );
  });
});
