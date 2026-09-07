import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readJsonlDelta } from "./bounded-jsonl-reader.mjs";
import { parseCliTranscriptEntries } from "./cli-session-reader.mjs";

const MAX_TURNS = 2_000;

function clone(value) {
  return value && typeof value === "object" ? structuredClone(value) : {};
}

function hashTurns(turns) {
  return createHash("sha256").update(JSON.stringify(turns)).digest("hex");
}

function minimalText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => ["text", "input_text", "output_text"].includes(block?.type))
    .map((block) => typeof block.text === "string" ? block.text : "").join("\n");
}

function mergeTurns(state, entries, client) {
  const next = clone(state);
  next.version = 1;
  next.client = client;
  next.records ??= {};
  next.turns ??= [];
  const accepted = [];
  for (const record of entries) {
    const sourceRecordId = `${record.offset}`;
    if (next.records[sourceRecordId]) continue;
    next.records[sourceRecordId] = true;
    accepted.push({ ...record.value, sourceRecordId });
  }

  if (client === "claude") {
    next.nodes ??= {};
    for (const entry of accepted) {
      if (!entry.uuid || entry.isMeta || !["user", "assistant"].includes(entry.type)) continue;
      const message = entry.message ?? {};
      const role = message.role;
      const text = role === "user" || role === "assistant"
        ? minimalText(message.content)
        : "";
      next.nodes[entry.uuid] = {
        uuid: entry.uuid,
        parentUuid: entry.parentUuid ?? null,
        type: entry.type,
        role,
        message: { role, content: text },
        timestamp: entry.timestamp,
        sourceRecordId: entry.sourceRecordId,
      };
    }
    const nodes = Object.values(next.nodes);
    const leaf = nodes.findLast((node) => ["user", "assistant"].includes(node.role));
    const active = new Set();
    let node = leaf;
    while (node && !active.has(node.uuid)) {
      active.add(node.uuid);
      node = next.nodes[node.parentUuid];
    }
    next.turns = parseCliTranscriptEntries(nodes.filter((item) => active.has(item.uuid)), {
      client, turnsOnly: true,
    }).turns;
  } else if (client === "antigravity") {
    next.steps ??= {};
    for (const entry of accepted) {
      if (!Number.isInteger(entry.step_index) || entry.status !== "DONE") continue;
      let role = null;
      if (entry.type === "USER_INPUT" && entry.source === "USER_EXPLICIT") role = "user";
      if (entry.type === "PLANNER_RESPONSE" && entry.source === "MODEL") role = "assistant";
      if (!role) continue;
      next.steps[String(entry.step_index)] = {
        step_index: entry.step_index,
        type: entry.type,
        source: entry.source,
        status: "DONE",
        content: minimalText(entry.content),
        timestamp: entry.timestamp ?? entry.created_at,
        sourceRecordId: entry.sourceRecordId,
      };
    }
    next.turns = parseCliTranscriptEntries(Object.values(next.steps), {
      client, turnsOnly: true,
    }).turns;
  } else {
    next.messages ??= [];
    for (const entry of accepted) {
      if (client === "codex") {
        const payload = entry.payload;
        if (entry.type !== "response_item" || payload?.type !== "message"
          || !["user", "assistant"].includes(payload.role) || payload.channel === "analysis") continue;
        next.messages.push({
          type: "response_item",
          timestamp: entry.timestamp,
          sourceRecordId: entry.sourceRecordId,
          payload: { type: "message", role: payload.role, content: minimalText(payload.content) },
        });
      } else if (client === "pi") {
        const message = entry.message;
        if (entry.type !== "message" || !["user", "assistant"].includes(message?.role)) continue;
        next.messages.push({
          type: "message",
          timestamp: entry.timestamp,
          sourceRecordId: entry.sourceRecordId,
          message: { role: message.role, content: minimalText(message.content) },
        });
      } else {
        next.messages.push(entry);
      }
    }
    next.turns = parseCliTranscriptEntries(next.messages, { client, turnsOnly: true }).turns;
  }
  // Keep the state bounded even when a client retains a very long session.
  if (next.turns.length > MAX_TURNS) next.turns = next.turns.slice(-MAX_TURNS);
  return next;
}

function healthFromDiagnostics(diagnostics, pendingBytes, prior = null) {
  const failureCode = diagnostics.at(-1)?.code ?? null;
  return {
    lastSuccessAt: diagnostics.length === 0 ? new Date().toISOString() : (prior?.health?.lastSuccessAt ?? null),
    pendingBytes,
    failureCode,
  };
}

function checkpointFromResult(result, adapterState, prior, repository, revision, health) {
  return {
    repository,
    sourceIdentity: result.checkpoint.sourceIdentity,
    offset: result.checkpoint.offset,
    partialRecord: result.checkpoint.partialRecord || null,
    adapterState: {
      ...adapterState,
      readerCheckpoint: result.checkpoint,
    },
    branchState: {
      generation: result.checkpoint.generation,
      reset: result.reset,
    },
    revision,
    expectedCheckpointRevision: prior?.checkpointRevision ?? 0,
    health,
  };
}

/**
 * Consume one bounded transcript delta and persist it after the async read.
 * `capture` is optional and is called inside the same synchronous DB
 * transaction after the checkpoint write, allowing extraction to remain owned
 * by the caller without making this reader depend on the extractor.
 */
export async function ingestCliTranscript({
  db,
  client,
  sessionId,
  transcriptPath,
  cwd,
  repository = null,
  capture = null,
  maxBytes = 4 * 1024 * 1024,
  maxRecordBytes = 1024 * 1024,
  budgetMs = 250,
} = {}) {
  if (!db || typeof db.getIngestionCheckpoint !== "function") throw new Error("Lore database is required");
  if (!client || !sessionId) throw new Error("client and sessionId are required");
  const prior = db.getIngestionCheckpoint(client, sessionId);
  const sourcePath = typeof transcriptPath === "string" && transcriptPath.startsWith("~/")
    ? path.join(os.homedir(), transcriptPath.slice(2)) : transcriptPath;
  const readerCheckpoint = prior?.adapterState?.readerCheckpoint ?? (prior ? {
    sourceIdentity: prior.sourceIdentity,
    offset: prior.offset,
    partialRecord: prior.partialRecord ?? "",
    sourceSize: prior.adapterState?.sourceSize,
    sourceMtimeMs: prior.adapterState?.sourceMtimeMs,
    generation: prior.branchState?.generation,
  } : null);
  let result;
  try {
    result = await readJsonlDelta(sourcePath, {
      checkpoint: readerCheckpoint,
      maxBytes,
      maxRecordBytes,
      budgetMs,
    });
  } catch (error) {
    const code = error?.code === "ENOENT" ? "source_missing" : "capture_read_failed";
    const health = { lastSuccessAt: prior?.health?.lastSuccessAt ?? null, pendingBytes: prior?.health?.pendingBytes ?? 0, failureCode: code };
    try {
      db.withSemanticMemoryTransaction(() => {
        db.saveIngestionCheckpoint(client, sessionId, {
          repository,
          sourceIdentity: prior?.sourceIdentity ?? null,
          offset: prior?.offset ?? 0,
          partialRecord: prior?.partialRecord ?? null,
          adapterState: prior?.adapterState ?? {},
          branchState: prior?.branchState ?? {},
          revision: prior?.revision ?? null,
          expectedCheckpointRevision: prior?.checkpointRevision ?? 0,
          health,
        });
      });
    } catch (persistError) {
      if (persistError?.code === "CHECKPOINT_REVISION_CONFLICT") return { status: "stale", health, errorCode: persistError.code };
    }
    return { status: "error", health, errorCode: code };
  }

  const generation = result.checkpoint.generation;
  const revision = `${generation}:${result.checkpoint.sourceSize}:${result.checkpoint.sourceMtimeMs}`;
  const previousState = result.reset ? {} : (prior?.adapterState ?? {});
  const adapterState = mergeTurns(previousState, result.records, client);
  const artifacts = parseCliTranscriptEntries(adapterState.turns.map((turn) => ({
    type: "normalized_turn", ...turn,
  })), { client, sessionId, cwd, repository, turnsOnly: false });
  artifacts.session.id = sessionId;
  artifacts.session.cwd = cwd;
  artifacts.session.repository = repository;
  const changed = hashTurns(adapterState.turns) !== (prior?.adapterState?.turnHash ?? "");
  adapterState.turnHash = hashTurns(adapterState.turns);
  const health = healthFromDiagnostics(result.diagnostics, result.checkpoint.pendingBytes, prior);
  const checkpoint = checkpointFromResult(result, adapterState, prior, repository, revision, health);
  try {
    db.withSemanticMemoryTransaction(() => {
      db.saveIngestionCheckpoint(client, sessionId, checkpoint);
      if (changed && adapterState.turns.length > 0 && typeof capture === "function") {
        capture({
          ...artifacts,
          turns: adapterState.turns.map((turn) => ({ ...turn, source_revision: revision })),
        }, { revision, result });
      }
    });
  } catch (error) {
    if (error?.code === "CHECKPOINT_REVISION_CONFLICT") return { status: "stale", health, errorCode: error.code };
    throw error;
  }
  return {
    status: result.checkpoint.pendingBytes > 0 ? "pending" : "captured",
    pending: result.checkpoint.pendingBytes > 0,
    records: result.records.length,
    turns: adapterState.turns.length,
    changed,
    reset: result.reset,
    checkpoint: db.getIngestionCheckpoint(client, sessionId),
    health,
  };
}
