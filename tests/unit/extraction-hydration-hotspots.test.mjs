import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { extractSessionMemories } from "../../lib/sessions/rule-extractor.mjs";
import { hydrateWorkstreamOverlay } from "../../lib/context/overlay-hydrator.mjs";

function createWorkspaceDir(name) {
  const workspacePath = mkdtempSync(path.join(os.tmpdir(), `lore-${name}-`));
  return {
    workspacePath,
    cleanup() {
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

describe("fourth-wave extraction and hydration hotspots", () => {
  test("session extraction captures warm colleague humor and name-use preferences", () => {
    const extraction = extractSessionMemories({
      repository: "fixture-repo",
      sessionId: "session-style",
      sessionArtifacts: {
        session: {},
        checkpoints: [],
        files: [],
        refs: [],
        turns: [{
          turn_index: 3,
          user_message: "Please talk to me like a warm colleague, feel free to use a little humor, and use my name naturally when it fits.",
        }],
      },
      workspace: {},
    });
    const memory = extraction.semanticMemories.find((entry) => entry.type === "interaction_style");

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
