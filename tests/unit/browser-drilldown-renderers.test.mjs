import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createAppRunner, createBrowserTestEnvironment, createDefaultFetch } from "../helpers/browser-dom.mjs";

const runApp = createAppRunner();

async function runBrowserApp({ drilldownHash, drilldownData }) {
  const { elements, document, history } = createBrowserTestEnvironment();
  const rafCallbacks = [];
  const window = {
    location: {
      hash: drilldownHash,
      pathname: "/browser",
      search: "",
    },
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    requestAnimationFrame(callback) {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    },
  };

  const fetch = createDefaultFetch({
    extra: (requestPath) => {
      if (requestPath.startsWith("/api/drilldown?")) {
        return Promise.resolve({ ok: true, json: async () => ({ data: drilldownData }) });
      }
    },
  });

  await runApp(document, window, fetch, history);

  return {
    drilldownHtml: elements.get("view-drilldown").innerHTML,
    rafCallbacks,
  };
}

describe("browser drilldown renderers", () => {
  test("renders memory drilldowns when day summaries omit episode arrays", async () => {
    const result = await runBrowserApp({
      drilldownHash: "#drilldown?entity=memory&id=mem-1",
      drilldownData: {
        entityType: "memory",
        focus: {
          id: "mem-1",
          title: "Focused memory",
          content: "Useful context for a hotspot refactor.",
          entityType: "memory",
          repository: "owner/repo",
          scope: "repo",
        },
        provenance: {
          day: {
            dateKey: "2024-05-01",
            summary: "Summarized without episode ids.",
            repository: "owner/repo",
          },
        },
        graph: {
          nodes: [],
          edges: [],
        },
      },
    });

    assert.match(result.drilldownHtml, /Provenance &amp; day grouping/);
    assert.match(result.drilldownHtml, /episodes=0/);
    assert.equal(result.rafCallbacks.length, 1);
  });

  test("renders session drilldowns when day summaries omit episode arrays", async () => {
    const result = await runBrowserApp({
      drilldownHash: "#drilldown?entity=session&id=session-1",
      drilldownData: {
        entityType: "session",
        focus: {
          sessionId: "session-1",
          title: "Focused session",
          summary: "Session summary for hotspot refactor work.",
          repository: "owner/repo",
          scope: "repo",
        },
        dayGroup: {
          day: {
            dateKey: "2024-05-02",
            summary: "Daily grouping without episode ids.",
            repository: "owner/repo",
          },
        },
        graph: {
          nodes: [],
          edges: [],
        },
      },
    });

    assert.match(result.drilldownHtml, /Day grouping/);
    assert.match(result.drilldownHtml, /episodes=0/);
    assert.equal(result.rafCallbacks.length, 1);
  });

  test("renders populated memory drilldown sections", async () => {
    const result = await runBrowserApp({
      drilldownHash: "#drilldown?entity=memory&id=mem-42",
      drilldownData: {
        entityType: "memory",
        focus: {
          id: "mem-42",
          title: "Canonical memory",
          content: "Track the canonical memory content.",
          entityType: "memory",
          type: "directive",
          repository: "owner/repo",
          scope: "transferable",
          status: "active",
          reinforcementCount: 3,
          canonicalKey: "mem/canonical",
          sourceTurnIndex: 7,
          metadata: {
            owner: "Lore",
            reviewers: ["Matt"],
          },
        },
        provenance: {
          sourceSession: {
            sessionId: "session-source",
            summary: "Source session summary",
            repository: "owner/repo",
            branch: "main",
            dateKey: "2024-05-01",
          },
          siblingSessions: [
            {
              sessionId: "session-sibling",
              summary: "Sibling session summary",
              repository: "owner/repo",
              dateKey: "2024-05-01",
            },
          ],
        },
        lineage: {
          supersededBy: {
            id: "mem-99",
            content: "Replacement memory",
            type: "directive",
            repository: "owner/repo",
            updatedAt: "2024-05-02T00:00:00.000Z",
          },
        },
        canonicalCluster: {
          key: "mem/canonical",
          totalMembers: 2,
          activeMembers: 1,
          totalReinforcement: 4,
          members: [
            {
              id: "mem-42",
              content: "Track the canonical memory content.",
              type: "directive",
              repository: "owner/repo",
              updatedAt: "2024-05-01T00:00:00.000Z",
            },
          ],
        },
        linkedImprovements: [
          {
            title: "Improve clustering",
            summary: "Keep cluster membership aligned.",
            status: "active",
            reviewState: "approved",
          },
        ],
        graph: {
          nodes: [],
          edges: [],
        },
      },
    });

    assert.match(result.drilldownHtml, /scope=transferable/);
    assert.match(result.drilldownHtml, /turn=7/);
    assert.match(result.drilldownHtml, /Source session/);
    assert.match(result.drilldownHtml, /Canonical cluster/);
    assert.match(result.drilldownHtml, /Improve clustering/);
    assert.match(result.drilldownHtml, /reviewers/);
  });

  test("renders populated session drilldown sections", async () => {
    const result = await runBrowserApp({
      drilldownHash: "#drilldown?entity=session&id=session-42",
      drilldownData: {
        entityType: "session",
        focus: {
          sessionId: "session-42",
          title: "Session drilldown",
          summary: "Review session details.",
          repository: "owner/repo",
          branch: "feature/browser",
          dateKey: "2024-05-03",
          scope: "repo",
          significance: 9,
          actions: ["Extracted helpers"],
          decisions: ["Keep browser output stable"],
          learnings: ["Tests pin drilldown sections"],
          openItems: ["Verify Fallow output"],
          filesChanged: ["browser/app.js"],
          actionCount: 1,
          decisionCount: 1,
          learningCount: 1,
          openItemCount: 1,
        },
        dayGroup: {
          day: {
            dateKey: "2024-05-03",
            summary: "Same day summary",
            repository: "owner/repo",
            episodeIds: ["session-42"],
            computedAt: "2024-05-03T10:00:00.000Z",
          },
          siblingSessions: [
            {
              sessionId: "session-43",
              summary: "Sibling summary",
              repository: "owner/repo",
              dateKey: "2024-05-03",
            },
          ],
        },
        sessionMemories: [
          {
            id: "mem-session",
            content: "Memory from session",
            type: "directive",
            repository: "owner/repo",
            updatedAt: "2024-05-03T11:00:00.000Z",
          },
        ],
        linkedImprovements: [
          {
            title: "Improve drilldown harness",
            summary: "Reuse the browser harness for regression coverage.",
            status: "active",
            reviewState: "approved",
          },
        ],
        graph: {
          nodes: [],
          edges: [],
        },
      },
    });

    assert.match(result.drilldownHtml, /feature\/browser/);
    assert.match(result.drilldownHtml, /Actions/);
    assert.match(result.drilldownHtml, /Extracted helpers/);
    assert.match(result.drilldownHtml, /episodes=1/);
    assert.match(result.drilldownHtml, /Session memory/);
    assert.match(result.drilldownHtml, /Improve drilldown harness/);
  });
});
