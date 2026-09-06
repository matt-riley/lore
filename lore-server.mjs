// lore-server.mjs — DB worker for the pi adapter.
//
// pi's extension runtime (bun 1.3.x) does not implement node:sqlite, which
// lore's lib/ requires. System node (>=22.5) does, so this server owns the
// lore database and serves the adapter over a JSON-lines protocol on stdin/
// stdout. lore's lib/ is used untouched.
//
// Protocol: one JSON object per line. Requests are processed strictly in
// order (a promise queue) so shutdown-time extraction and close never race.
//   -> { id, method, params }
//   <- { id, ok: true, result } | { id, ok: false, error }
//
// Methods:
//   status           - store statistics
//   recall           - recallMemory (prompt context + onboarding/directives)
//   search           - searchSemantic (typed fallback supported)
//   save / onboard   - retainMemory
//   extract          - extract memories from one pi session file
//   backfill         - bounded scan + extraction of unprocessed pi sessions
//   post_tool        - passive post-tool-use observation (rollout-gated)
//   error            - error telemetry (rollout-gated)
//   guardrail        - pre-tool-use guardrail (rollout-gated)
//   close            - close db and exit

import os from "node:os";
import path from "node:path";
import { loadConfig } from "./lib/config.mjs";
import { LoreDb } from "./lib/db.mjs";
import { seedOnboardingMemories } from "./lib/onboarding.mjs";
import { recallMemory, retainMemory } from "./lib/memory-operations.mjs";
import { applySessionExtraction } from "./lib/backfill.mjs";
import { buildErrorTelemetryRecord, buildPostToolUseObservation } from "./lib/passive-hooks.mjs";
import {
  readErrorTelemetryEnabled,
  readPostToolUseEnabled,
  readPreToolUseGuardrailEnabled,
} from "./lib/rollout-flags.mjs";
import { runPreToolUseGuardrail } from "./lib/pre-tool-use-guardrail.mjs";
import { readPiSessionFile } from "./pi-session-reader.mjs";
import { PiArchiveScanner, parseBackfillSettings } from "./lib/pi-archive-scanner.mjs";

const RECALL_TYPES = [
  "commitment",
  "open_loop",
  "rejected_approach",
  "blocker",
  "user_preference",
  "assistant_identity",
  "user_identity",
  "assistant_goal",
  "recurring_mistake",
  "interaction_style",
];

// Bounded pi-session backfill knobs. Invalid values fall back to safe defaults.
const BACKFILL = parseBackfillSettings();

let db = null;
let errorTelemetryWrites = 0;
let archiveScanner = null;
let archiveQueue = [];
let archiveQueuedPaths = new Set();
let archiveWorkerRunning = false;
let archiveIdle = Promise.resolve();
let resolveArchiveIdle = null;
let archiveScanQueue = Promise.resolve();
let archiveScanScheduled = false;

function expandHome(p) {
  if (typeof p !== "string" || !p) {
    return p;
  }
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function piSessionDir() {
  const configured = db?.config?.paths?.piSessionDir;
  return expandHome(configured) || path.join(os.homedir(), ".pi", "agent", "sessions");
}

function archiveCursorPath() {
  const derivedStorePath = expandHome(db?.config?.paths?.derivedStorePath);
  return derivedStorePath
    ? `${derivedStorePath}.pi-archive-cursor.json`
    : path.join(os.homedir(), ".copilot", "lore-archive-cursor.json");
}

async function init() {
  const config = await loadConfig();
  if (config?.enabled !== true) {
    throw new Error('lore is disabled — set "enabled": true in ~/.copilot/lore.json');
  }
  db = new LoreDb(config);
  db.initialize();
  seedOnboardingMemories({ db, sessionId: "lore-server" });
  archiveScanner = new PiArchiveScanner({
    rootDir: piSessionDir(),
    scanCap: BACKFILL.scanCap,
    minAgeMs: BACKFILL.minAgeMs,
    maxFileBytes: BACKFILL.maxFileBytes,
    cursorPath: archiveCursorPath(),
    isAlreadyExtracted: (sessionId) => alreadyExtracted(sessionId),
  });
  return { schemaVersion: db.getStats().schemaVersion };
}

function maybeCompactErrorTelemetry() {
  errorTelemetryWrites += 1;
  if (errorTelemetryWrites % 20 !== 0) {
    return;
  }
  db.pruneErrorTelemetry({
    maxRowsGlobal: 500,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  });
}

function alreadyExtracted(sessionId) {
  if (!sessionId) {
    return false;
  }
  // LoreDb wraps the raw node:sqlite handle as `db.db`; there is no public
  // episode-existence query, so reach into it for a cheap existence check.
  return !!db.db.prepare("SELECT session_id FROM episode_digest WHERE session_id = ?").get(sessionId);
}

function extractPiSession(filePath, repository) {
  const parsed = readPiSessionFile(filePath, { repository });
  if (parsed.sessionArtifacts.turns.length === 0) {
    return { extracted: false, reason: "no_turns", sessionId: parsed.sessionId };
  }
  const workspace = {
    workspace: {
      repository: parsed.repository,
      branch: null,
      updated_at: parsed.sessionArtifacts.session.updated_at,
    },
  };
  const extraction = applySessionExtraction({
    db,
    sessionId: parsed.sessionId,
    repository: parsed.repository,
    sessionArtifacts: parsed.sessionArtifacts,
    workspace,
  });
  return {
    extracted: true,
    sessionId: parsed.sessionId,
    episodeId: extraction.episodeDigest.id,
    memoryCount: extraction.semanticMemories.length,
    turns: parsed.sessionArtifacts.turns.length,
    files: parsed.sessionArtifacts.files.length,
  };
}

function yieldToForeground() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function runArchiveQueue() {
  while (archiveQueue.length > 0) {
    // Give requests already waiting on stdin a chance to run between archive
    // files. Extraction itself remains one ordered DB mutation at a time.
    await yieldToForeground();
    const candidate = archiveQueue.shift();
    if (!candidate) {
      continue;
    }
    try {
      const result = extractPiSession(candidate.path, null);
      if (result.extracted) {
        console.error(
          `[lore-server] imported ${candidate.sessionId?.slice(0, 8)}: ${result.memoryCount} memories, ${result.turns} turns`,
        );
      }
    } catch (error) {
      console.error(`[lore-server] backfill failed for ${candidate.path}: ${error?.message ?? String(error)}`);
    } finally {
      archiveQueuedPaths.delete(candidate.path);
    }
  }
  archiveWorkerRunning = false;
  resolveArchiveIdle?.();
  resolveArchiveIdle = null;
}

function queueArchiveCandidates(candidates) {
  let queued = 0;
  for (const candidate of candidates) {
    if (archiveQueuedPaths.has(candidate.path)) {
      continue;
    }
    archiveQueuedPaths.add(candidate.path);
    archiveQueue.push(candidate);
    queued += 1;
  }
  if (queued > 0 && !archiveWorkerRunning) {
    archiveWorkerRunning = true;
    archiveIdle = new Promise((resolve) => {
      resolveArchiveIdle = resolve;
    });
    void runArchiveQueue();
  }
  return queued;
}

function waitForArchiveIdle() {
  return archiveScanQueue.then(() => archiveWorkerRunning ? archiveIdle : undefined);
}

async function dispatch(method, params) {
  switch (method) {
    case "recall": {
      const recall = recallMemory({
        db,
        prompt: params.prompt,
        retrievalPrompt: params.retrievalPrompt ?? null,
        repository: params.repository ?? null,
        includeOtherRepositories: true,
        limit: params.limit ?? 6,
        sessionStore: null,
      });
      const hits = recall?.trace?.lookups?.localMemories?.includedRows;
      return {
        text: recall?.text?.trim() ?? "",
        includedRows: Array.isArray(hits) ? hits.length : 0,
        // Cheap gate for query expansion: only expand when the store has real
        // content worth finding (seeded onboarding alone doesn't count).
        memoryCount: db.db
          .prepare("SELECT count(*) AS c FROM semantic_memory WHERE superseded_by IS NULL")
          .get().c ?? 0,
      };
    }
    case "search": {
      const rows = db.searchSemantic({
        query: params.query,
        repository: params.repository ?? null,
        includeOtherRepositories: true,
        types: params.types ?? RECALL_TYPES,
        includeTypedFallback: params.includeTypedFallback ?? false,
        limit: params.limit ?? 6,
      });
      return rows.map((r) => ({ id: r.id, type: r.type, content: r.content }));
    }
    case "save": {
      const retained = retainMemory({
        db,
        kind: "semantic",
        memory: {
          type: params.type ?? "user_preference",
          content: params.content,
          confidence: params.confidence ?? 0.9,
          repository: params.repository ?? null,
          scope: params.scope,
          sourceSessionId: params.sourceSessionId ?? null,
          tags: params.tags ?? [(params.type ?? "user_preference"), "manual"],
          metadata: params.metadata ?? { source: "pi" },
        },
      });
      return { id: retained?.id ?? null };
    }
    case "onboard": {
      // Delegate to lore's own onboarding pipeline so personality updates use
      // the same canonical-key upserts as the Copilot lore_onboard tool.
      const { readOnboardingState, resolveOnboardingInput } = await import("./lib/onboarding.mjs");
      const { persistOnboardingMemories } = await import("./lib/memory-tools-admin.mjs");
      const built = resolveOnboardingInput({
        existingState: readOnboardingState({ db }),
        userName: params.userName,
        assistantName: params.assistantName,
        profile: {
          ...(params.voice !== undefined ? { voice: params.voice } : {}),
          ...(params.warmth !== undefined ? { warmth: params.warmth } : {}),
          ...(params.humor !== undefined ? { humor: params.humor } : {}),
          ...(params.humorFrequency !== undefined ? { humorFrequency: params.humorFrequency } : {}),
          ...(params.collaborative !== undefined ? { collaborative: params.collaborative } : {}),
          ...(params.useNameNaturally !== undefined ? { useNameNaturally: params.useNameNaturally } : {}),
        },
        sessionId: params.sourceSessionId ?? null,
      });
      persistOnboardingMemories(db, built.memories);
      return {
        assistantName: built.assistantName,
        userName: built.userName,
        profile: built.profile,
      };
    }
    case "extract": {
      const filePath = String(params.path ?? "");
      if (!filePath) {
        throw new Error("extract requires a session file path");
      }
      return extractPiSession(filePath, params.repository ?? null);
    }
    case "backfill": {
      // Discovery is independent of the foreground request queue. Returning
      // immediately lets the first recall/status request run while the
      // bounded async walker inspects archive entries.
      if (!archiveScanScheduled) {
        archiveScanScheduled = true;
        archiveScanQueue = archiveScanQueue.then(async () => {
          const scan = await archiveScanner.scan({
            currentSessionId: params.currentSessionId ?? null,
            maxCandidates: Math.max(1, Number(params.max ?? BACKFILL.max)),
          });
          queueArchiveCandidates(scan.candidates);
        }).catch((error) => {
          console.error(`[lore-server] backfill scan failed: ${error?.message ?? String(error)}`);
        }).finally(() => {
          archiveScanScheduled = false;
        });
      }
      return { scanned: 0, queued: 0, exhausted: false, pending: true, processed: [] };
    }
    case "semantic_search": {
      const { semanticSearch } = await import("./lib/semantic-search.mjs");
      return await semanticSearch({
        db,
        query: String(params.query ?? ""),
        repository: params.repository ?? null,
        types: RECALL_TYPES,
        limit: params.limit ?? 6,
      });
    }
    case "expand": {
      // Query expansion via the local chat model (Gemma3). Opt-in via
      // localInference.queryExpansion.enabled; fails open to the deterministic
      // query on any error so recall never breaks.
      const { expandRetrievalQueryWithLocalInference } = await import("./lib/local-inference-augmentation.mjs");
      const fallback = params.query ?? params.prompt ?? "";
      try {
        const result = await expandRetrievalQueryWithLocalInference({
          config: db.config?.localInference,
          prompt: params.prompt ?? "",
          deterministicQuery: String(fallback),
        });
        return result;
      } catch (error) {
        return {
          query: fallback,
          deterministicQuery: fallback,
          addedTerms: [],
          used: false,
          error: error?.message ?? String(error),
        };
      }
    }
    case "post_tool": {
      if (!readPostToolUseEnabled(db.config)) {
        return { enabled: false };
      }
      const observation = buildPostToolUseObservation(params.payload);
      if (!observation) {
        return { captured: false };
      }
      db.insertTrajectoryArtifact({
        kind: "passive_hook_observation",
        repository: null,
        summary: `${observation.toolCategory}/${observation.success ? "success" : "failure"}`,
        severity: observation.success ? "info" : "warning",
        outcome: "captured",
        context: {
          hookKind: "onPostToolUse",
          toolCategory: observation.toolCategory,
          success: observation.success,
          argsShape: observation.argsShape,
        },
      });
      return { captured: true };
    }
    case "error": {
      if (!readErrorTelemetryEnabled(db.config)) {
        return { enabled: false };
      }
      const record = buildErrorTelemetryRecord(params.payload, params.sessionId ?? null);
      if (!record) {
        return { captured: false };
      }
      db.insertErrorTelemetry(record);
      maybeCompactErrorTelemetry();
      return { captured: true };
    }
    case "guardrail": {
      if (!readPreToolUseGuardrailEnabled(db.config)) {
        return { enabled: false };
      }
      const result = await runPreToolUseGuardrail(
        { toolName: params.toolName ?? "", toolArgs: {} },
        { config: db.config },
      );
      return { additionalContext: result?.additionalContext ?? null };
    }
    case "status": {
      const s = db.getStats();
      return {
        semanticCount: s.semanticCount ?? 0,
        episodeCount: s.episodeCount ?? 0,
        domainCount: s.domainCount ?? 0,
        observationCount: s.observationCount ?? 0,
        schemaVersion: s.schemaVersion ?? "?",
        dbPath: s.dbPath ?? null,
      };
    }
    case "close":
      await waitForArchiveIdle();
      return { closing: true };
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

const started = await init().catch((error) => error);
if (started instanceof Error) {
  console.error(`[lore-server] init failed: ${started.message}`);
  process.exit(1);
}

const readline = await import("node:readline");
const rl = readline.createInterface({ input: process.stdin });

// Serial queue: requests run strictly in order so extraction + close never race.
let queue = Promise.resolve();
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  queue = queue
    .then(() => dispatch(req.method ?? "", req.params ?? {}))
    .then((result) => {
      process.stdout.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
    })
    .catch((error) => {
      process.stdout.write(
        JSON.stringify({ id: req.id, ok: false, error: error?.message ?? String(error) }) + "\n",
      );
    });
});

rl.on("close", () => {
  queue.then(async () => {
    await waitForArchiveIdle();
    await archiveScanner?.close();
  }).finally(() => {
    try {
      db?.close();
    } catch {
      // best-effort
    }
    process.exit(0);
  });
});
