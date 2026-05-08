import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { extractSessionMemories } from "../../lib/rule-extractor.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

let browserServerHotspotsPromise = null;

async function loadBrowserServerHotspots() {
  if (!browserServerHotspotsPromise) {
    const serverPath = "/Users/matthew.riley/.copilot/extensions/lore/browser/server.mjs";
    const serverUrl = pathToFileURL(serverPath).href;
    const source = readFileSync(serverPath, "utf8")
      .replace(/from "\.\.\/lib\/maintenance-scheduler\.mjs"/g, `from "${pathToFileURL("/Users/matthew.riley/.copilot/extensions/lore/lib/maintenance-scheduler.mjs").href}"`)
      .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url))', `const __dirname = ${JSON.stringify("/Users/matthew.riley/.copilot/extensions/lore/browser")}`)
      .replace("function buildMemoryDrilldown({ db, id, entityType }) {", "export function buildMemoryDrilldown({ db, id, entityType }) {");
    browserServerHotspotsPromise = import(`data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=${serverUrl}\n`).toString("base64")}`);
  }
  return browserServerHotspotsPromise;
}

describe("fifth-wave rule extractor and browser server hotspots", () => {
  test("extractSessionMemories prefers explicit repository and preserves explicit/open-loop memories", () => {
    const extraction = extractSessionMemories({
      sessionId: "session-hotspot",
      repository: "explicit-repo",
      sessionArtifacts: {
        session: {
          repository: "session-repo",
          branch: null,
          summary: "",
          updated_at: "2024-06-02T10:00:00.000Z",
        },
        checkpoints: [{
          overview: "",
          work_done: "Added browser drilldown regression coverage",
          technical_details: "Reduced extractSessionMemories complexity",
          next_steps: "- Verify browser drilldown hotspot\n- Ship scoped refactor",
        }],
        files: [{ file_path: "lib/rule-extractor.mjs" }],
        refs: [{ ref_type: "issue", ref_value: "512" }],
        turns: [
          {
            turn_index: 1,
            user_message: "I prefer concise status updates.",
            assistant_response: "",
          },
          {
            turn_index: 2,
            user_message: "Help me reduce the rule extractor hotspot complexity without changing behavior.",
            assistant_response: "",
          },
        ],
      },
      workspace: {
        workspace: {
          repository: "workspace-repo",
          branch: "feature/hotspot",
          updated_at: "2024-06-03T10:00:00.000Z",
        },
      },
    });

    assert.deepEqual(extraction.episodeDigest, {
      id: "session-hotspot",
      sessionId: "session-hotspot",
      repository: "explicit-repo",
      branch: "feature/hotspot",
      summary: extraction.episodeDigest.summary,
      actions: extraction.episodeDigest.actions,
      decisions: extraction.episodeDigest.decisions,
      learnings: ["I prefer concise status updates."],
      filesChanged: ["lib/rule-extractor.mjs"],
      refs: ["issue:512"],
      significance: extraction.episodeDigest.significance,
      themes: extraction.episodeDigest.themes,
      openItems: ["Verify browser drilldown hotspot", "Ship scoped refactor"],
      source: "rule",
      dateKey: "2024-06-02",
      createdAt: "2024-06-02T10:00:00.000Z",
    });
    assert.equal(extraction.semanticMemories.some((memory) => memory.type === "assistant_goal"), true);
    assert.equal(extraction.semanticMemories.some((memory) => memory.type === "user_preference"), true);
    assert.deepEqual(
      extraction.semanticMemories.filter((memory) => memory.type === "open_loop").map((memory) => ({
        content: memory.content,
        repository: memory.repository,
      })),
      [
        { content: "Verify browser drilldown hotspot", repository: "explicit-repo" },
        { content: "Ship scoped refactor", repository: "explicit-repo" },
      ],
    );
  });

  test("buildMemoryDrilldown includes placeholder provenance, cluster members, and linked improvements", { skip: SKIP_NO_FTS5 }, async () => {
    const { buildMemoryDrilldown } = await loadBrowserServerHotspots();
    const { db, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
      },
    });

    try {
      const memoryId = db.insertSemanticMemory({
        id: "mem-focus",
        type: "assistant_goal",
        content: "Current assistant goal: keep browser drilldown behavior stable.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-missing",
        sourceTurnIndex: 7,
        canonicalKey: "assistant_goal:keep browser drilldown behavior stable",
        tags: ["assistant-goal", "browser"],
      });
      db.insertSemanticMemory({
        id: "mem-cluster",
        type: "assistant_goal",
        content: "Current assistant goal: keep browser drilldown behavior stable for the browser pane.",
        repository: "fixture-repo",
        scope: "repo",
        tags: ["assistant-goal", "browser"],
      });
      db.db.prepare("UPDATE semantic_memory SET canonical_key = ? WHERE id = ?").run(
        "assistant_goal:current assistant goal keep browser drilldown behavior stable",
        "mem-cluster",
      );
      db.insertSemanticMemory({
        id: "mem-superseded",
        type: "assistant_goal",
        content: "Older browser drilldown goal.",
        repository: "fixture-repo",
        scope: "repo",
        supersededBy: memoryId,
        tags: ["assistant-goal"],
      });
      const improvementId = db.upsertImprovementArtifact({
        sourceCaseId: "browser-drilldown",
        sourceKind: "replay",
        title: "Improve drilldown hotspot coverage",
        summary: "Pin placeholder provenance behavior.",
        linkedMemoryId: memoryId,
        evidence: { mode: "prompt" },
        trace: {},
      });

      const drilldown = buildMemoryDrilldown({
        db,
        id: memoryId,
        entityType: "memory",
      });

      assert.equal(drilldown.focus.id, memoryId);
      assert.equal(drilldown.provenance.sourceSession.sessionId, "session-missing");
      assert.equal(drilldown.provenance.sourceSession.summary, "Source session digest not available yet");
      assert.equal(drilldown.provenance.sourceTurnIndex, 7);
      assert.equal(drilldown.canonicalCluster.key, "assistant_goal:current assistant goal keep browser drilldown behavior stable");
      assert.equal(drilldown.canonicalCluster.members.length, 2);
      assert.deepEqual(drilldown.lineage.supersedes.map((memory) => memory.id), ["mem-superseded"]);
      assert.deepEqual(drilldown.linkedImprovements.map((improvement) => improvement.id), [improvementId]);
      assert.equal(drilldown.graph.nodes.some((node) => node.id === "session:session-missing" && node.navigable === false), true);
      assert.equal(drilldown.graph.edges.some((edge) => edge.type === "linked_memory"), true);
      assert.equal(drilldown.graph.edges.some((edge) => edge.type === "canonical_cluster"), true);
    } finally {
      cleanup();
    }
  });
});
