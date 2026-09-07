import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { startLoreBrowserServer } from "../../browser/server.mjs";
import { LoreDb } from "../../lib/db/db.mjs";
import { createAppRunner, createBrowserTestEnvironment } from "../helpers/browser-dom.mjs";
import { enabledConfig } from "../helpers/fixture-config.mjs";

const runApp = createAppRunner();

function response(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    },
  };
}

async function fixtureFetch(path) {
  const data = {
    "/api/health": { repository: "owner/repo" },
    "/api/overview": {
      data: {
        stats: { semanticCount: 1 },
        captureHealth: [{
          client: "codex",
          sessionId: "codex:session-1",
          repository: "owner/repo",
          lastSuccessAt: "2026-09-07T08:00:00.000Z",
          pendingBytes: 128,
          offset: 1024,
          resumeCommand: "printf '%s\\n' '{\"cwd\":\"/tmp/project\"}' | node lore-cli.mjs capture --resume --client 'codex' --session 'session-1'",
        }],
        indexing: {
          enabled: true,
          totalActive: 4,
          indexed: 3,
          pending: 1,
          coveragePercent: 75,
          fallbackDiagnostics: [{ reason: "partial_embedding_coverage", count: 2 }],
        },
      },
    },
    "/api/maintenance": { data: {} },
    "/api/episodes": { data: {} },
    "/api/memories/filters": { data: {} },
  };
  if (data[path]) return response(data[path]);
  if (path.startsWith("/api/memories?")) {
    return response({ data: { rows: [] } });
  }
  if (path === "/api/drilldown?entity=memory&id=memory-1") {
    return response({
      data: {
        entityType: "memory",
        focus: {
          id: "memory-1",
          entityType: "memory",
          title: "Use SQLite",
          content: "Use SQLite for this project.",
          type: "directive",
          repository: "owner/repo",
          scope: "repo",
          status: "active",
          reinforcementCount: 1,
          metadata: {},
          createdAt: "2026-09-07T07:00:00.000Z",
          updatedAt: "2026-09-07T07:30:00.000Z",
        },
        provenance: {},
        lineage: {},
        lifecycle: {
          state: { memory: "active", suppression: "none", expiry: "none" },
          evidence: [{
            sourceKind: "preference",
            sourceRole: "user",
            confidenceBasis: "explicit_preference_sentence",
            sourceRecordId: "turn-4",
            sessionId: "codex:session-1",
            revision: "rev-4",
            capturedAt: "2026-09-07T07:01:00.000Z",
          }],
          suppressions: [],
          timeline: [{ kind: "created", label: "Memory created", at: "2026-09-07T07:00:00.000Z" }],
        },
        canonicalCluster: null,
        linkedImprovements: [],
        graph: { nodes: [], edges: [] },
      },
    });
  }
  throw new Error(`Unexpected fixture fetch: ${path}`);
}

function makeWindow(hash = "") {
  return {
    location: { hash, pathname: "/", search: "" },
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    setTimeout,
  };
}

describe("reliability dashboard renderers", () => {
  test("overview exposes capture resume and embedding coverage diagnostics", async () => {
    const { elements, document, history } = createBrowserTestEnvironment();
    await runApp(document, makeWindow(), fixtureFetch, history);
    const html = elements.get("view-overview")?.innerHTML ?? "";
    assert.match(html, /Capture health/);
    assert.match(html, /Copy preview command/);
    assert.match(html, /Embedding coverage/);
    assert.match(html, /partial_embedding_coverage/);
  });

  test("memory drilldown exposes attributed evidence and lifecycle state", async () => {
    const { elements, document, history } = createBrowserTestEnvironment();
    await runApp(document, makeWindow("#drilldown?entity=memory&id=memory-1"), fixtureFetch, history);
    const html = elements.get("view-drilldown")?.innerHTML ?? "";
    assert.match(html, /Evidence & lifecycle/);
    assert.match(html, /role=user/);
    assert.match(html, /explicit_preference_sentence/);
    assert.match(html, /source ref=turn-4/);
    assert.match(html, /Memory created/);
    assert.match(html, /memory_correct/);
    assert.match(html, /memory_repair/);
    assert.match(html, /memory_purge/);
    assert.match(html, /preview only/);
  });

  test("server drilldown returns evidence and lifecycle state from an isolated fixture", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "lore-browser-server-fixture-"));
    const db = new LoreDb(enabledConfig(home));
    db.initialize();
    const [memoryId] = db.reconcileGeneratedMemories({
      sessionId: "codex:fixture",
      repository: "owner/repo",
      memories: [{
        type: "directive",
        content: "Use the fixture database.",
        confidence: 0.9,
        scope: "repo",
        metadata: {
          sourceRole: "user",
          confidenceBasis: "explicit_preference_sentence",
        },
        evidence: {
          key: "fixture:server-evidence",
          sourceRecordId: "turn-1",
          sourceKind: "preference",
        },
      }],
    });
    const { server } = startLoreBrowserServer({ db, host: "127.0.0.1", port: 0, repository: "owner/repo" });
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const responseValue = await fetch(`http://127.0.0.1:${server.address().port}/api/drilldown?entity=memory&id=${memoryId}`);
      const payload = await responseValue.json();
      assert.equal(responseValue.status, 200);
      assert.equal(payload.mode, "read_only");
      assert.equal(payload.data.lifecycle.evidence[0].sourceRole, "user");
      assert.equal(payload.data.lifecycle.evidence[0].sourceRecordId, "turn-1");
      assert.equal(payload.data.lifecycle.state.correction, "none");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    }
  });
});
