import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hydrateWorkstreamOverlay } from "../../lib/overlay-hydrator.mjs";

let ruleExtractorHotspotsPromise = null;

async function loadRuleExtractorHotspots() {
  if (!ruleExtractorHotspotsPromise) {
    const ruleExtractorPath = "/Users/matthew.riley/.copilot/extensions/lore/lib/rule-extractor.mjs";
    const ruleExtractorUrl = pathToFileURL(ruleExtractorPath).href;
    const source = readFileSync(ruleExtractorPath, "utf8")
      .replace(/from "\.\/memory-scope\.mjs"/g, `from "${pathToFileURL("/Users/matthew.riley/.copilot/extensions/lore/lib/memory-scope.mjs").href}"`)
      .replace(/from "\.\/rollout-flags\.mjs"/g, `from "${pathToFileURL("/Users/matthew.riley/.copilot/extensions/lore/lib/rollout-flags.mjs").href}"`)
      .replace(/from "\.\/retention-sanitizer\.mjs"/g, `from "${pathToFileURL("/Users/matthew.riley/.copilot/extensions/lore/lib/retention-sanitizer.mjs").href}"`)
      .replace(/from "\.\/text-normalizer\.mjs"/g, `from "${pathToFileURL("/Users/matthew.riley/.copilot/extensions/lore/lib/text-normalizer.mjs").href}"`)
      .replace("function extractInteractionStyleMemory({ message, repository, sessionId, turnIndex }) {", "export function extractInteractionStyleMemory({ message, repository, sessionId, turnIndex }) {");
    ruleExtractorHotspotsPromise = import(`data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=${ruleExtractorUrl}\n`).toString("base64")}`);
  }
  return ruleExtractorHotspotsPromise;
}

function createWorkspaceDir(name) {
  const root = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".scratch",
    "extraction-hydration-hotspots",
  );
  mkdirSync(root, { recursive: true });
  const workspacePath = path.join(root, `${name}-${process.pid}-${Date.now()}`);
  mkdirSync(workspacePath, { recursive: true });
  return {
    workspacePath,
    cleanup() {
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

describe("fourth-wave extraction and hydration hotspots", () => {
  test("extractInteractionStyleMemory captures warm colleague humor and name-use preferences", async () => {
    const { extractInteractionStyleMemory } = await loadRuleExtractorHotspots();
    const memory = extractInteractionStyleMemory({
      message: "Please talk to me like a warm colleague, feel free to use a little humor, and use my name naturally when it fits.",
      repository: "fixture-repo",
      sessionId: "session-style",
      turnIndex: 3,
    });

    assert.equal(memory.type, "interaction_style");
    assert.equal(memory.repository, null);
    assert.deepEqual(memory.tags, [
      "interaction-style",
      "colleague",
      "warm",
      "light",
      "collaborative",
      "use-name-naturally",
    ]);
    assert.deepEqual(memory.metadata.profile, {
      voice: "colleague",
      warmth: "warm",
      humor: "light",
      humorFrequency: "occasional",
      collaborative: true,
      useNameNaturally: true,
    });
  });

  test("hydrateWorkstreamOverlay builds a blocked overlay from local plan artifacts", async () => {
    const { workspacePath, cleanup } = createWorkspaceDir("overlay");
    let insertedMemory = null;
    writeFileSync(path.join(workspacePath, "plan.md"), `---
task_id: extraction-hydration-hotspots
status: in_progress
---

## goal
Keep overlay hydration stable during fallow refactors.

## current_state
Capturing extraction and hydration hotspot coverage.
`, "utf8");

    const result = await hydrateWorkstreamOverlay({
      db: {
        config: {
          rollout: {
            memoryOperations: true,
            workstreamOverlays: true,
          },
        },
        db: {
          prepare() {
            return {
              all() {
                return [{
                  task_name: "doctorSnapshot",
                  last_status: "failed",
                  total_failures: 2,
                  consecutive_failures: 2,
                }];
              },
            };
          },
        },
        insertSemanticMemory(memory) {
          insertedMemory = memory;
          return "overlay-1";
        },
      },
      workspacePath,
      repository: "fixture-repo",
      sessionId: "session-overlay",
    });

    try {
      assert.deepEqual(result, {
        skipped: false,
        id: "overlay-1",
        overlayId: "extraction-hydration-hotspots",
        title: "Extraction Hydration Hotspots",
        status: "blocked",
        blockerCount: 1,
        nextActionCount: 0,
      });
      assert.equal(insertedMemory.type, "workstream_overlay");
      assert.equal(insertedMemory.metadata.source, "overlay_hydrator");
      assert.equal(insertedMemory.metadata.overlayId, "extraction-hydration-hotspots");
      assert.equal(insertedMemory.metadata.title, "Extraction Hydration Hotspots");
      assert.deepEqual(insertedMemory.metadata.blockers, [
        "maintenance/doctorSnapshot: failed (2 total failures)",
      ]);
      assert.deepEqual(insertedMemory.metadata.nextActions, []);
      assert.equal(insertedMemory.metadata.hasPlan, true);
      assert.equal(insertedMemory.metadata.maintenanceBlockerCount, 1);
    } finally {
      cleanup();
    }
  });
});
