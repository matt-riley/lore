import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readJsonlDelta } from "./bounded-jsonl-reader.mjs";

const MAX_TURNS = 2_000;
const MAX_NODES = 4_096;
const MAX_RECORD_IDS = 4_096;

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

function turnRevision(turn) {
  return createHash("sha256").update(JSON.stringify({
    user: turn.user_message,
    assistant: turn.assistant_response,
  })).digest("hex");
}

function rememberRecord(next, id) {
  next.processedRecordIds ??= [];
  if (next.processedRecordIds.includes(id)) return false;
  next.processedRecordIds.push(id);
  if (next.processedRecordIds.length > MAX_RECORD_IDS) next.processedRecordIds.splice(0, next.processedRecordIds.length - MAX_RECORD_IDS);
  return true;
}

function addUserTurn(next, text, timestamp, sourceRecordId) {
  if (!text.trim()) return;
  next.nextTurnIndex = (next.nextTurnIndex ?? 0) + 1;
  const turn = {
    turn_index: next.nextTurnIndex,
    user_message: text.trim(),
    assistant_response: "",
    timestamp,
    source_record_id: sourceRecordId,
    assistant_source_record_ids: [],
  };
  turn.source_revision = turnRevision(turn);
  next.turns.push(turn);
}

function addAssistantText(next, text, sourceRecordId = null) {
  if (!text.trim() || next.turns.length === 0) return;
  const turn = next.turns.at(-1);
  turn.assistant_response = `${turn.assistant_response ? `${turn.assistant_response}\n` : ""}${text.trim()}`;
  if (sourceRecordId && !turn.assistant_source_record_ids.includes(sourceRecordId)) turn.assistant_source_record_ids.push(sourceRecordId);
  turn.source_revision = turnRevision(turn);
}

function activeClaudeNodeIds(nodes, leafUuid) {
  const active = new Set();
  let node = nodes[leafUuid];
  while (node && !active.has(node.uuid)) {
    active.add(node.uuid);
    node = nodes[node.parentUuid];
  }
  return active;
}

function rebuildClaudeBranch(next) {
  const active = activeClaudeNodeIds(next.nodes, next.activeLeafUuid);
  const branch = Object.values(next.nodes)
    .filter((node) => active.has(node.uuid))
    .sort((left, right) => left.order - right.order);
  const rebuilt = { turns: [], nextTurnIndex: 0 };
  for (const node of branch) {
    if (node.role === "user") addUserTurn(rebuilt, node.text, node.timestamp, node.sourceRecordId);
    else if (node.role === "assistant") addAssistantText(rebuilt, node.text, node.sourceRecordId);
  }
  const oldIds = new Set((next.turns ?? []).flatMap((turn) => [turn.source_record_id, ...(turn.assistant_source_record_ids ?? [])]).filter(Boolean));
  const newIds = new Set(rebuilt.turns.flatMap((turn) => [turn.source_record_id, ...(turn.assistant_source_record_ids ?? [])]).filter(Boolean));
  next.abandonedSourceRecordIds ??= [];
  for (const id of oldIds) if (!newIds.has(id) && !next.abandonedSourceRecordIds.includes(id)) next.abandonedSourceRecordIds.push(id);
  next.turns = rebuilt.turns;
  next.nextTurnIndex = rebuilt.nextTurnIndex;
  next.activeNodeIds = [...active];
}

function mergeTurns(state, entries, client) {
  const next = clone(state);
  next.version = 1;
  next.client = client;
  next.turns ??= [];
  next.abandonedSourceRecordIds ??= [];
  const accepted = [];
  for (const record of entries) {
    const sourceRecordId = `${record.offset}`;
    const value = record.value;
    const payload = value?.payload;
    const message = value?.message;
    const relevant = client === "claude"
      ? Boolean(value?.uuid && !value.isMeta && ["user", "assistant"].includes(value.type))
      : client === "antigravity"
        ? Boolean(Number.isInteger(value?.step_index) && value.status === "DONE"
          && ((value.type === "USER_INPUT" && value.source === "USER_EXPLICIT")
            || (value.type === "PLANNER_RESPONSE" && value.source === "MODEL")))
        : client === "codex"
          ? Boolean(value?.type === "response_item" && payload?.type === "message"
            && ["user", "assistant"].includes(payload.role) && payload.channel !== "analysis")
          : client === "pi"
            ? Boolean(value?.type === "message" && ["user", "assistant"].includes(message?.role))
            : false;
    if (!relevant || !rememberRecord(next, sourceRecordId)) continue;
    const sourceRevision = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    accepted.push({ ...value, sourceRecordId, sourceRevision });
  }

  if (client === "claude") {
    next.nodes ??= {};
    next.nextNodeOrder ??= 0;
    let nodeRevised = false;
    for (const entry of accepted) {
      if (!entry.uuid || entry.isMeta || !["user", "assistant"].includes(entry.type)) continue;
      const message = entry.message ?? {};
      const role = message.role;
      const text = role === "user" || role === "assistant"
        ? minimalText(message.content)
        : "";
      const prior = next.nodes[entry.uuid];
      if (prior && prior.sourceRevision !== entry.sourceRevision && prior.sourceRecordId
        && !next.abandonedSourceRecordIds.includes(prior.sourceRecordId)) {
        next.abandonedSourceRecordIds.push(prior.sourceRecordId);
        nodeRevised = true;
      }
      next.nodes[entry.uuid] = {
        uuid: entry.uuid,
        parentUuid: entry.parentUuid ?? null,
        type: entry.type,
        role,
        text,
        timestamp: entry.timestamp,
        sourceRecordId: entry.sourceRecordId,
        sourceRevision: entry.sourceRevision,
        order: prior?.order ?? ++next.nextNodeOrder,
      };
      next.activeLeafUuid = entry.uuid;
    }
    const active = new Set(next.activeNodeIds ?? []);
    const leaf = next.nodes[next.activeLeafUuid];
    const extendsActive = leaf && (!active.size
      ? !leaf.parentUuid
      : leaf.parentUuid === next.activeLeafUuid);
    if (!active.size || !extendsActive || nodeRevised) rebuildClaudeBranch(next);
    else {
      next.activeNodeIds.push(next.activeLeafUuid);
      if (leaf.role === "user") addUserTurn(next, leaf.text, leaf.timestamp, leaf.sourceRecordId);
      else addAssistantText(next, leaf.text, leaf.sourceRecordId);
    }
    const keep = new Set(next.activeNodeIds);
    const ordered = Object.values(next.nodes).sort((left, right) => right.order - left.order);
    for (const node of ordered.slice(MAX_NODES)) if (!keep.has(node.uuid)) delete next.nodes[node.uuid];
    if (next.activeNodeIds.length > MAX_NODES) {
      next.activeNodeIds = next.activeNodeIds.slice(-MAX_NODES);
      for (const uuid of Object.keys(next.nodes)) if (!next.activeNodeIds.includes(uuid)) delete next.nodes[uuid];
      const first = next.nodes[next.activeNodeIds[0]];
      if (first) first.parentUuid = null;
    }
  } else if (client === "antigravity") {
    next.steps ??= {};
    next.stepRecordIds ??= {};
    for (const entry of accepted) {
      if (!Number.isInteger(entry.step_index) || entry.status !== "DONE") continue;
      let role = null;
      if (entry.type === "USER_INPUT" && entry.source === "USER_EXPLICIT") role = "user";
      if (entry.type === "PLANNER_RESPONSE" && entry.source === "MODEL") role = "assistant";
      if (!role) continue;
      const key = String(entry.step_index);
      const prior = next.steps[key];
      if (prior?.sourceRecordId && prior.sourceRevision !== entry.sourceRevision
        && !next.abandonedSourceRecordIds.includes(prior.sourceRecordId)) next.abandonedSourceRecordIds.push(prior.sourceRecordId);
      next.steps[key] = {
        step_index: entry.step_index,
        type: entry.type,
        source: entry.source,
        status: "DONE",
        content: minimalText(entry.content),
        timestamp: entry.timestamp ?? entry.created_at,
        sourceRecordId: entry.sourceRecordId,
        sourceRevision: entry.sourceRevision,
      };
      next.stepRecordIds[key] = entry.sourceRecordId;
      const existingTurn = next.turns.find((turn) => turn.step_index === entry.step_index);
      if (existingTurn) {
        if (role === "user") existingTurn.user_message = minimalText(entry.content).trim();
        else existingTurn.assistant_response = minimalText(entry.content).trim();
        existingTurn.source_revision = turnRevision(existingTurn);
      } else if (role === "user") {
        addUserTurn(next, minimalText(entry.content), entry.timestamp ?? entry.created_at, entry.sourceRecordId);
        next.turns.at(-1).step_index = entry.step_index;
      } else {
        const priorTurn = [...next.turns].reverse().find((turn) => (turn.step_index ?? -1) < entry.step_index);
        if (priorTurn) {
          priorTurn.assistant_response = minimalText(entry.content).trim();
          priorTurn.assistant_source_record_ids = [entry.sourceRecordId];
          priorTurn.source_revision = turnRevision(priorTurn);
        }
      }
    }
    const stepKeys = Object.keys(next.steps).sort((left, right) => Number(left) - Number(right));
    for (const key of stepKeys.slice(0, Math.max(0, stepKeys.length - MAX_NODES))) delete next.steps[key];
  } else {
    for (const entry of accepted) {
      let role = null;
      let content = "";
      if (client === "codex") {
        const payload = entry.payload;
        if (entry.type !== "response_item" || payload?.type !== "message"
          || !["user", "assistant"].includes(payload.role) || payload.channel === "analysis") continue;
        role = payload.role;
        content = minimalText(payload.content);
      } else if (client === "pi") {
        const message = entry.message;
        if (entry.type !== "message" || !["user", "assistant"].includes(message?.role)) continue;
        role = message.role;
        content = minimalText(message.content);
      }
      if (role === "user") addUserTurn(next, content, entry.timestamp ?? entry.created_at, entry.sourceRecordId);
      else if (role === "assistant") addAssistantText(next, content, entry.sourceRecordId);
    }
  }
  // Keep the state bounded even when a client retains a very long session.
  if (next.turns.length > MAX_TURNS) next.turns = next.turns.slice(-MAX_TURNS);
  if (next.abandonedSourceRecordIds.length > MAX_RECORD_IDS) next.abandonedSourceRecordIds.splice(0, next.abandonedSourceRecordIds.length - MAX_RECORD_IDS);
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
  const previousTurns = prior?.adapterState?.turns ?? [];
  const previousSourceIds = previousTurns.flatMap((turn) => [turn.source_record_id, ...(turn.assistant_source_record_ids ?? [])]).filter(Boolean);
  const previousState = result.reset
    ? { abandonedSourceRecordIds: [...new Set([...(prior?.adapterState?.abandonedSourceRecordIds ?? []), ...previousSourceIds])] }
    : (prior?.adapterState ?? {});
  const adapterState = mergeTurns(previousState, result.records, client);
  const artifacts = {
    session: {
      id: sessionId,
      cwd,
      repository,
      branch: null,
      summary: "",
      created_at: adapterState.turns[0]?.timestamp ?? new Date().toISOString(),
      updated_at: adapterState.turns.at(-1)?.timestamp ?? new Date().toISOString(),
    },
    turns: adapterState.turns,
    checkpoints: [],
    files: [],
    refs: [],
    retiredSourceRecordIds: adapterState.abandonedSourceRecordIds ?? [],
  };
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
          turns: adapterState.turns,
        }, { revision, result });
      }
    });
  } catch (error) {
    if (error?.code === "CHECKPOINT_REVISION_CONFLICT") return { status: "stale", health, errorCode: error.code };
    // Extraction failures must remain retryable: the cursor/evidence write
    // above rolled back, so record only categorical health against the same
    // prior checkpoint and leave its offset untouched.
    const failureHealth = {
      lastSuccessAt: prior?.health?.lastSuccessAt ?? null,
      pendingBytes: prior?.health?.pendingBytes ?? result.checkpoint.pendingBytes,
      failureCode: "capture_failed",
    };
    try {
      db.withSemanticMemoryTransaction(() => {
        db.saveIngestionCheckpoint(client, sessionId, {
          repository: prior?.repository ?? repository,
          sourceIdentity: prior?.sourceIdentity ?? null,
          offset: prior?.offset ?? 0,
          partialRecord: prior?.partialRecord ?? null,
          adapterState: prior?.adapterState ?? {},
          branchState: prior?.branchState ?? {},
          revision: prior?.revision ?? null,
          expectedCheckpointRevision: prior?.checkpointRevision ?? 0,
          health: failureHealth,
        });
      });
    } catch (healthError) {
      if (healthError?.code === "CHECKPOINT_REVISION_CONFLICT") return { status: "stale", health: failureHealth, errorCode: healthError.code };
    }
    return { status: "error", health: failureHealth, errorCode: "capture_failed" };
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
