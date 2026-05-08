import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";

import { buildSemanticCanonicalKey } from "../../lib/memory-scope.mjs";
import { parseArgs } from "../../scripts/run-browser.mjs";

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
