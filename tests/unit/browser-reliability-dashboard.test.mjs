import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { startLoreBrowserServer } from "../../browser/server.mjs";
import { LoreDb } from "../../lib/db/db.mjs";
import { embeddingContentHash } from "../../lib/memory/semantic-search.mjs";
import { createAppRunner, createBrowserTestEnvironment } from "../helpers/browser-dom.mjs";
import { buildFixtureConfig, enabledConfig } from "../helpers/fixture-config.mjs";

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
    assert.match(html, /Copy resume command/);
    assert.match(html, />pending</);
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
    assert.match(html, /\/absolute\/path\/to\/lore\/lore-cli\.mjs/);
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
    const evidenceKey = db.listSemanticEvidence(memoryId)[0].key;
    db.db.prepare("UPDATE session_evidence SET retired_at = ? WHERE evidence_key = ?").run("2026-09-07T09:00:00.000Z", evidenceKey);
    db.db.prepare("UPDATE memory_evidence SET retired_at = ? WHERE memory_id = ? AND evidence_key = ?").run("2026-09-07T09:05:00.000Z", memoryId, evidenceKey);
    db.db.prepare(`INSERT INTO memory_suppression (suppression_key, memory_id, scope, repository, actor, reason, created_at, superseded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("suppression:fixture", memoryId, "repo", "owner/repo", "fixture", "reviewed test suppression", "2026-09-07T08:30:00.000Z", null);
    db.db.prepare(`INSERT INTO memory_suppression (suppression_key, memory_id, scope, repository, actor, reason, created_at, superseded_at, repair_candidate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("suppression:repair-candidate", memoryId, "repo", "owner/repo", "migration", "legacy repair candidate", "2026-09-07T08:00:00.000Z", null, 1);
    const { server } = startLoreBrowserServer({ db, host: "127.0.0.1", port: 0, repository: "owner/repo" });
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const responseValue = await fetch(`http://127.0.0.1:${server.address().port}/api/drilldown?entity=memory&id=${memoryId}`);
      const payload = await responseValue.json();
      assert.equal(responseValue.status, 200);
      assert.equal(payload.mode, "read_only");
      assert.equal(payload.data.lifecycle.evidence[0].sourceRole, "user");
      assert.equal(payload.data.lifecycle.evidence[0].sourceRecordId, "turn-1");
      assert.equal(payload.data.lifecycle.state.suppression, "suppressed");
      assert.equal(payload.data.lifecycle.state.activeSuppressionCount, 1);
      const evidenceTimeline = payload.data.lifecycle.timeline.filter((item) => item.kind.includes("evidence"));
      assert.deepEqual(new Set(evidenceTimeline.map((item) => item.kind)), new Set(["evidence", "evidence_retired", "evidence_link_retired"]));
      assert.equal(evidenceTimeline.find((item) => item.kind === "evidence_retired").at, "2026-09-07T09:00:00.000Z");
      assert.equal(evidenceTimeline.find((item) => item.kind === "evidence_link_retired").at, "2026-09-07T09:05:00.000Z");
      assert.deepEqual(payload.data.lifecycle.timeline.find((item) => item.kind === "suppression" && item.actor === "fixture"), {
        at: "2026-09-07T08:30:00.000Z",
        kind: "suppression",
        label: "Suppression recorded",
        actor: "fixture",
        reason: "reviewed test suppression",
      });
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    }
  });

  test("overview reports valid eligible cache coverage and categorical fallback diagnostics", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "lore-browser-coverage-fixture-"));
    const config = buildFixtureConfig(home, {
      enabled: true,
      localInference: { enabled: true, embeddings: { enabled: true, model: "fixture-model" } },
    });
    const db = new LoreDb(config);
    db.initialize();
    const [activeId, expiredId] = db.reconcileGeneratedMemories({
      sessionId: "codex:coverage",
      repository: "owner/repo",
      memories: [
        { type: "user_preference", content: "Use the active fixture memory.", scope: "repo", repository: "owner/repo" },
        { type: "user_preference", content: "Use the expired fixture memory.", scope: "repo", repository: "owner/repo" },
      ],
    });
    db.db.prepare("UPDATE semantic_memory SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", expiredId);
    db.ensureMemoryEmbeddingTable();
    db.saveIngestionCheckpoint("codex", "session-1", {
      repository: "owner/repo",
      adapterState: { sourcePath: "/tmp/transcript.jsonl", sourceCwd: "/tmp/project", cleanupCursor: "" },
      health: { pendingBytes: 0 },
    });
    db.db.prepare(`INSERT OR REPLACE INTO memory_embedding (memory_id, content_hash, provider, model, dimensions, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(activeId, embeddingContentHash("Use the active fixture memory."), "http://127.0.0.1:12434/v1", "fixture-model", 2, "[1,0]", "2026-09-07T08:00:00.000Z");
    db.insertRetrievalTraceSample({
      id: "trace-coverage",
      repository: "owner/repo",
      scopeType: "repo",
      hook: "test",
      route: "lexical",
      routeReason: "fallback",
      contextInjected: false,
      latencyMs: 1,
      promptPreview: "fixture",
      sectionTitles: [],
      promptNeed: {},
      eligibility: {},
      lookups: {},
      omissions: [],
      output: {},
      trace: { fallback: true, partialCoverage: true, deadline: true },
      recordedAt: "2026-09-07T08:00:00.000Z",
    });
    db.insertRetrievalTraceSample({
      id: "trace-prompt-lookalike",
      repository: "owner/repo",
      scopeType: "repo",
      hook: "test",
      route: "lexical",
      routeReason: "primary",
      promptPreview: 'The prompt contains "fallback": true, "partialCoverage": true, and "deadline": true.',
      trace: {},
      recordedAt: "2026-09-07T08:01:00.000Z",
    });
    const { server } = startLoreBrowserServer({ db, host: "127.0.0.1", port: 0, repository: "owner/repo" });
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const responseValue = await fetch(`http://127.0.0.1:${server.address().port}/api/overview`);
      const payload = await responseValue.json();
      assert.equal(responseValue.status, 200);
      assert.equal(payload.data.indexing.totalActive, 1);
      assert.equal(payload.data.indexing.sampleSize, 1);
      assert.equal(payload.data.indexing.indexed, 1);
      assert.equal(payload.data.indexing.pending, 0);
      assert.equal(payload.data.indexing.dimensionsBasis, "stored vector dimensions");
      assert.equal(payload.data.captureHealth[0].resumeEligible, true);
      assert.match(payload.data.captureHealth[0].resumeCommand, /node ['"]?[^ ]*lore-cli\.mjs['"]? capture --resume/);
      assert.equal(payload.data.captureHealth[0].pendingWork.cleanup, true);
      assert.equal(payload.data.captureHealth[0].hasPendingWork, true);
      assert.equal(payload.data.captureHealth[0].status, "pending");
      assert.deepEqual(payload.data.indexing.fallbackDiagnostics, [
        { reason: "deterministic_fallback", count: 1 },
        { reason: "partial_embedding_coverage", count: 1 },
        { reason: "embedding_deadline", count: 1 },
      ]);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    }
  });

  test("overview disables embedding coverage when the model is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "lore-browser-invalid-embedding-fixture-"));
    const config = buildFixtureConfig(home, {
      enabled: true,
      localInference: { enabled: true, embeddings: { enabled: true, model: "   " } },
    });
    const db = new LoreDb(config);
    db.initialize();
    const { server } = startLoreBrowserServer({ db, host: "127.0.0.1", port: 0, repository: "owner/repo" });
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const responseValue = await fetch(`http://127.0.0.1:${server.address().port}/api/overview`);
      const payload = await responseValue.json();
      assert.equal(responseValue.status, 200);
      assert.equal(payload.data.indexing.enabled, false);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    }
  });
});
