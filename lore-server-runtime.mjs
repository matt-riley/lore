// lore-server.mjs — DB worker for the pi adapter.
//
// pi's extension runtime (bun 1.3.x) does not implement node:sqlite, which
// lore's lib/ requires. System node (>=24.0.0) does, so this server owns the
// lore database and serves the adapter over a JSON-lines protocol on stdin/
// stdout. lore's lib/ is used untouched.
//
// Protocol: one JSON object per line. Requests are processed strictly in
// order (a promise queue) so shutdown-time extraction and close never race.
//   -> { id, method, params }
//   <- { id, ok: true, result } | { id, ok: false, error }
//
// Methods:
//   tool             - createLoreSession.dispatchOperation(name, args) mapped to the protocol
//   lifecycle        - createLoreSession.handleLifecycle(event, payload); a
//                      "session_start" event also fires the bounded
//                      background maintenance sweep in-process (fire-and-
//                      forget, guarded by a cross-process DB lock — see
//                      runBackgroundMaintenanceSweep)
//   slash            - createLoreSession.dispatchSlash(args)
//   status           - store statistics (alias; prefer tool lore_status)
//   recall           - assembleRecall (alias; prefer tool lore_recall)
//   search           - searchSemantic (typed fallback supported)
//   save / onboard   - retainMemory (alias; prefer tool lore_retain / lore_onboard)
//   extract          - extract memories from one pi session file
//   backfill         - bounded scan + extraction of unprocessed pi sessions
//   post_tool        - passive post-tool-use observation (rollout-gated)
//   error            - error telemetry (rollout-gated)
//   guardrail        - pre-tool-use guardrail (rollout-gated)
//   close            - close db and exit

import os from "node:os";
import path from "node:path";
import { resolveLorePaths } from "./lib/core/lore-paths.mjs";
import { seedOnboardingMemories } from "./lib/memory/onboarding.mjs";
import { createLoreSession } from "./lib/runtime/lore-runtime.mjs";
import { requireDispatchOutcome } from "./lib/runtime/operation-dispatch.mjs";
import { retainMemory } from "./lib/memory/memory-operations.mjs";
import { assembleRecall } from "./lib/context/recall-assembler.mjs";
import { EpisodeSessionSource } from "./lib/runtime/session-source.mjs";
import { onSessionCapture, recordErrorTelemetry, recordPostToolUseObservation } from "./lib/lifecycle/session-lifecycle.mjs";
import { readPreToolUseGuardrailEnabled } from "./lib/rollout/rollout-flags.mjs";
import { runPreToolUseGuardrail } from "./lib/lifecycle/pre-tool-use-guardrail.mjs";
import { readPiSessionHeader } from "./pi-session-reader.mjs";
import { ingestCliTranscript } from "./lib/clients/cli-transcript-ingestion.mjs";
import { PiArchiveScanner, parseBackfillSettings, resolvePiSessionDir } from "./lib/sessions/pi-archive-scanner.mjs";
import { runBackgroundMaintenanceSweep } from "./lib/maintenance/maintenance-scheduler.mjs";

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
  "decision",
  "interaction_style",
  "learned_rule",
];

// Bounded pi-session backfill knobs. Invalid values fall back to safe defaults.
const BACKFILL = parseBackfillSettings();

let session = null;
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
let maintenanceRunning = false;
let maintenanceIdle = Promise.resolve();
let resolveMaintenanceIdle = null;

function expandHome(p) {
  if (typeof p !== "string" || !p) {
    return p;
  }
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function piSessionDir() {
  return resolvePiSessionDir({ paths: db?.config?.paths });
}

function archiveCursorPath() {
  const derivedStorePath = expandHome(db?.config?.paths?.derivedStorePath);
  return derivedStorePath
    ? `${derivedStorePath}.pi-archive-cursor.json`
    : `${resolveLorePaths().derivedStorePath}.pi-archive-cursor.json`;
}

function toolResultText(result) {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object" && typeof result.text === "string") {
    return result.text;
  }
  if (result == null) {
    return "";
  }
  return JSON.stringify(result);
}

async function init() {
  session = await createLoreSession({
    client: "pi",
    surface: "hook",
    cwd: process.cwd(),
  });
  if (!session.initialized || !session.db) {
    throw session.lastError ?? new Error("lore unavailable");
  }
  db = session.db;
  seedOnboardingMemories({ db, sessionId: "lore-server" });
  archiveScanner = new PiArchiveScanner({
    rootDir: piSessionDir(),
    scanCap: BACKFILL.scanCap,
    minAgeMs: BACKFILL.minAgeMs,
    maxFileBytes: BACKFILL.maxFileBytes,
    cursorPath: archiveCursorPath(),
    isAlreadyExtracted: (sessionId, source) => alreadyExtracted(sessionId, source),
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

function alreadyExtracted(sessionId, source = null) {
  if (!sessionId) {
    return false;
  }
  const checkpoint = db.getIngestionCheckpoint("pi", sessionId);
  if (checkpoint) {
    const reader = checkpoint.adapterState?.readerCheckpoint;
    if (checkpoint.health.pendingBytes > 0 || checkpoint.adapterState?.cleanupCursor != null || checkpoint.adapterState?.branchWork) return false;
    if (!source) return true;
    const sourceIdentity = source.sourceIdentity ?? (source.dev !== undefined && source.ino !== undefined ? `${source.dev}:${source.ino}` : null);
    const recordedIdentity = reader?.sourceIdentity ?? checkpoint.sourceIdentity ?? null;
    const sourceSize = source.sourceSize ?? source.size;
    const sourceMtimeMs = source.sourceMtimeMs ?? source.mtimeMs;
    return Boolean(sourceIdentity && recordedIdentity === sourceIdentity
      && reader?.sourceSize === sourceSize && reader?.sourceMtimeMs === sourceMtimeMs
      && Number.isFinite(source.sourceCtimeMs) && reader?.sourceCtimeMs === source.sourceCtimeMs);
  }
  if (source) return false;
  // LoreDb wraps the raw node:sqlite handle as `db.db`; there is no public
  // episode-existence query, so reach into it for a cheap existence check.
  return !!db.db.prepare("SELECT session_id FROM episode_digest WHERE session_id = ?").get(sessionId);
}

async function extractPiSession(filePath, repository, { useEnvironmentRepository = true } = {}) {
  const parsed = await readPiSessionHeader(filePath, {
    repository,
    mappings: db?.getRepositoryMappings?.() ?? [],
    useEnvironmentRepository,
  });
  if (!parsed.sessionId) return { extracted: false, reason: "missing_session_id", sessionId: null };
  let extractionResult = null;
  const captureResult = await ingestCliTranscript({
    db,
    client: "pi",
    sessionId: parsed.sessionId,
    nativeId: parsed.sessionId,
    transcriptPath: filePath,
    cwd: parsed.cwd,
    repository: parsed.repository,
    capture: (artifacts) => {
      const { captureState, extraction } = onSessionCapture({
        db,
        sessionId: parsed.sessionId,
        repository: parsed.repository,
        config: db.config,
        artifacts,
      });
      extractionResult = { extracted: true, episodeId: extraction.episodeDigest.id, memoryCount: extraction.semanticMemories.length };
      return captureState;
    },
  });
  if (captureResult.status === "error" || captureResult.status === "stale") {
    const error = new Error(`Capture failed: ${captureResult.errorCode ?? "capture_failed"}`);
    error.code = captureResult.errorCode;
    throw error;
  }
  const state = captureResult.checkpoint?.adapterState;
  const runnablePending = captureResult.pending && (state?.readerCheckpoint?.offset < state?.readerCheckpoint?.sourceSize
    || state?.cleanupCursor != null || Boolean(state?.branchWork));
  return { ...(extractionResult ?? { extracted: false, reason: captureResult.pending ? "pending" : "no_turns" }),
    sessionId: parsed.sessionId, repository: parsed.repository, pending: captureResult.pending ?? false, runnablePending,
    turns: captureResult.turns ?? 0, files: 0, health: captureResult.health };

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
      const result = await extractPiSession(candidate.path, candidate.repository ?? null, { useEnvironmentRepository: false });
      if (result.runnablePending) archiveQueue.push(candidate);
      if (result.extracted) {
        console.error(
          `[lore-server] imported ${candidate.sessionId?.slice(0, 8)}: ${result.memoryCount} memories, ${result.turns} turns`,
        );
      }
    } catch (error) {
      const sessionId = String(candidate.sessionId ?? "unknown").slice(0, 8);
      const filename = path.basename(candidate.path).replace(/[\r\n]/g, "");
      const code = error?.code ?? "capture_failed";
      const detail = error?.message
        ? `: ${String(error.message).replace(/\s+/g, " ").slice(0, 240)}`
        : "";
      console.error(`[lore-server] archive capture failed session=${sessionId} file=${filename} code=${code}${detail}`);
    } finally {
      if (!archiveQueue.some((queued) => queued.path === candidate.path)) archiveQueuedPaths.delete(candidate.path);
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

// pi's adapter never had an equivalent of Copilot's onSessionStart maintenance
// trigger — lore-server is a long-lived worker, so unlike native CLI hooks it
// can run the bounded sweep in-process rather than spawning a child. It still
// takes the same cross-process lock (via runBackgroundMaintenanceSweep) since
// a native CLI hook's background child could be running against this same
// database concurrently. Fire-and-forget: must never block the lifecycle
// response the adapter is waiting on for recall context.
function maybeRunBackgroundMaintenance(repository) {
  if (maintenanceRunning || !db) {
    return;
  }
  maintenanceRunning = true;
  maintenanceIdle = new Promise((resolve) => {
    resolveMaintenanceIdle = resolve;
  });
  runBackgroundMaintenanceSweep({
    runtime: {
      db,
      config: db.config,
      sessionStore: session?.sessionStore ?? session?.sessionSource ?? null,
      repository,
    },
    repository,
  }).catch((error) => {
    console.error(`[lore-server] background maintenance failed: ${error?.message ?? String(error)}`);
  }).finally(() => {
    maintenanceRunning = false;
    resolveMaintenanceIdle?.();
    resolveMaintenanceIdle = null;
  });
}

function waitForMaintenanceIdle() {
  return maintenanceRunning ? maintenanceIdle : Promise.resolve();
}

function invocationExtra(params, surface) {
  const extra = {
    sessionId: params.sessionId ?? session?.sessionId ?? null,
    surface,
  };
  if (Object.hasOwn(params, "repository")) {
    extra.repository = params.repository;
  }
  return extra;
}

async function dispatch(method, params) {
  switch (method) {
    case "tool": {
      if (!session) {
        throw new Error("lore unavailable");
      }
      const name = String(params.name ?? "");
      const result = await session.dispatchOperation(name, params.args ?? {}, invocationExtra(params, params.surface ?? "tool"));
      // Explicit error contract: unknown/unavailable tools stay as text,
      // handler failures become protocol errors (ok:false) for the adapter.
      return toolResultText(requireDispatchOutcome(result, { name }));
    }
    case "lifecycle": {
      if (!session) {
        throw new Error("lore unavailable");
      }
      const event = String(params.event ?? "");
      const eventRepository = Object.hasOwn(params, "repository") ? params.repository : session.repository;
      const result = await session.handleLifecycle(event, {
        prompt: params.prompt ?? params.initialPrompt ?? "",
        initialPrompt: params.initialPrompt ?? params.prompt ?? "",
        repository: eventRepository,
        sessionId: params.sessionId ?? session.sessionId,
      });
      if (event === "session_start") {
        // Not awaited: maintenance runs alongside subsequent queued requests,
        // never delaying the recall context this response carries.
        maybeRunBackgroundMaintenance(eventRepository);
      }
      return {
        text: result?.text ?? "",
        additionalContext: result?.additionalContext,
      };
    }
    case "slash": {
      if (!session) {
        throw new Error("lore unavailable");
      }
      const text = await session.dispatchSlash(params.args ?? "", invocationExtra(params, "slash"));
      return toolResultText(text);
    }
    case "recall": {
      let recall = await assembleRecall({
        db,
        prompt: params.prompt,
        retrievalPrompt: params.retrievalPrompt ?? null,
        repository: params.repository ?? null,
        includeOtherRepositories: params.includeOtherRepositories === true,
        limit: params.limit ?? 6,
        sessionSource: new EpisodeSessionSource(db, { client: "pi" }),
        config: db.config,
      });
      const hits = recall?.trace?.lookups?.localMemories?.includedRows;
      return {
        text: recall?.text?.trim() ?? "",
        includedRows: (Array.isArray(hits) ? hits.length : 0) + (recall.semanticMatches?.length ?? 0),
        estimatedTokens: recall.estimatedTokens,
        semanticDiagnostics: recall.semanticDiagnostics ?? null,
        trace: recall.trace,
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
        includeOtherRepositories: params.includeOtherRepositories === true,
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
      const { readOnboardingState, resolveOnboardingInput } = await import("./lib/memory/onboarding.mjs");
      const { persistOnboardingMemories } = await import("./lib/tools/memory-tools-admin.mjs");
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
      const result = await extractPiSession(filePath, params.repository ?? null);
      if (result.runnablePending) queueArchiveCandidates([{ path: filePath, sessionId: result.sessionId, repository: result.repository }]);
      return result;
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
      const { semanticSearch } = await import("./lib/memory/semantic-search.mjs");
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
      const { expandRetrievalQueryWithLocalInference } = await import("./lib/inference/local-inference-augmentation.mjs");
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
      const result = recordPostToolUseObservation({
        db,
        config: db.config,
        repository: null,
        payload: params.payload,
        contextFields: (observation) => ({ hookKind: "onPostToolUse", argsShape: observation.argsShape }),
      });
      if (result.reason === "disabled") {
        return { enabled: false };
      }
      return { captured: result.recorded };
    }
    case "error": {
      const result = recordErrorTelemetry({
        db,
        config: db.config,
        payload: params.payload,
        sessionId: params.sessionId ?? null,
        onCompact: maybeCompactErrorTelemetry,
      });
      if (result.reason === "disabled") {
        return { enabled: false };
      }
      return { captured: result.recorded };
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
        captureHealth: db.listCaptureHealth(),
      };
    }
    case "close":
      await waitForArchiveIdle();
      await waitForMaintenanceIdle();
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
    await waitForMaintenanceIdle();
    await archiveScanner?.close();
  }).finally(() => {
    try {
      session?.close();
    } catch {
      // best-effort
    }
    process.exit(0);
  });
});
