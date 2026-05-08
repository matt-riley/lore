import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";

import { MEMORY_SCOPE, classifySemanticMemory } from "../../lib/memory-scope.mjs";
import { parseArgs } from "../../scripts/run-maintenance.mjs";

describe("run-maintenance parseArgs", () => {
  test("keeps status dry-run behavior while parsing task and path overrides", () => {
    const args = parseArgs([
      "--status",
      "--tasks",
      " validationCorpus, replayCorpus ,doctorSnapshot ",
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
      "--force",
    ]);

    assert.deepEqual(args, {
      action: "status",
      dryRun: true,
      force: true,
      tasks: ["validationCorpus", "replayCorpus", "doctorSnapshot"],
      repository: "owner/test-repo",
      configPath: path.resolve(process.cwd(), "./fixtures/lore.json"),
      derivedStorePath: path.resolve(process.cwd(), "./fixtures/lore.db"),
      backupDir: path.resolve(process.cwd(), "./fixtures/backups"),
      rawStorePath: path.resolve(process.cwd(), "./fixtures/session-store.db"),
    });
  });
});

describe("classifySemanticMemory", () => {
  test("keeps repo-specific user preferences local even when transferable or style cues appear", () => {
    const classification = classifySemanticMemory({
      type: "user_preference",
      repository: "owner/test-repo",
      content: "In this repo, keep the workflow migration playbook aligned with this repository style.",
    });

    assert.deepEqual(classification, {
      scope: MEMORY_SCOPE.REPO,
      repository: "owner/test-repo",
      metadata: {},
    });
  });

  test("keeps recurring mistakes global even when repository text is present", () => {
    const classification = classifySemanticMemory({
      type: "recurring_mistake",
      repository: "owner/test-repo",
      content: "Do not regress this repo release migration checklist again.",
    });

    assert.deepEqual(classification, {
      scope: MEMORY_SCOPE.GLOBAL,
      repository: null,
      metadata: {
        originRepository: "owner/test-repo",
      },
    });
  });
});
