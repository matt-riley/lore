import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { stripInjectedContext } from "../memory/retention-sanitizer.mjs";
import { readJsonlDelta } from "./bounded-jsonl-reader.mjs";

const MAX_TURNS = 20;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_ASSISTANT_RECORDS = 20;
const MAX_NODES = 4_096;
const MAX_RECORD_IDS = 64;

function clone(value) {
  return value && typeof value === "object" ? structuredClone(value) : {};
}

function minimalText(content) {
  if (typeof content === "string") return stripInjectedContext(content);
  if (!Array.isArray(content)) return "";
  return stripInjectedContext(content.filter((block) => ["text", "input_text", "output_text"].includes(block?.type))
    .map((block) => typeof block.text === "string" ? block.text : "").join("\n"));
}

function timestampOf(value) {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function antigravityText(content) {
  const text = minimalText(content);
  return text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u)?.[1] ?? text;
}

function turnRevision(turn) {
  return createHash("sha256").update(JSON.stringify({
    user: turn.user_message,
    role: "user",
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
    timestamp: timestampOf(timestamp),
    source_record_id: sourceRecordId,
    assistant_source_record_ids: [],
    assistant_source_records: [],
  };
  turn.source_revision = turnRevision(turn);
  next.turns.push(turn);
}

function addAssistantText(next, text, sourceRecordId = null) {
  if (!text.trim()) return;
  if (next.turns.length === 0) next.turns.push({ turn_index: 1, user_message: "", assistant_response: "",
    source_record_id: null, source_revision: null, assistant_source_record_ids: [], assistant_source_records: [] });
  const turn = next.turns.at(-1);
  turn.assistant_source_records ??= [];
  turn.assistant_source_records.push({
    source_record_id: sourceRecordId,
    source_revision: createHash("sha256").update(JSON.stringify({ role: "assistant", text: text.trim() })).digest("hex"),
    text: text.trim(),
  });
  turn.assistant_source_records = turn.assistant_source_records.slice(-MAX_ASSISTANT_RECORDS);
  while (turn.assistant_source_records.length > 1
    && turn.assistant_source_records.reduce((bytes, record) => bytes + Buffer.byteLength(record.text), 0) > MAX_TEXT_BYTES) {
    turn.assistant_source_records.shift();
  }
  turn.assistant_response = turn.assistant_source_records.map((record) => record.text).join("\n");
  // A delta contains at most 128 KiB of accepted records (or one indivisible
  // record). If this combination exceeds the retained window, its user record
  // necessarily came from an earlier committed pass and need not be extracted
  // again. Keep its identity/revision while evicting already captured text.
  if (Buffer.byteLength(turn.user_message) + Buffer.byteLength(turn.assistant_response) > MAX_TEXT_BYTES) turn.user_message = "";
  turn.assistant_source_record_ids = turn.assistant_source_records.map((record) => record.source_record_id);
}

function relevantRecord(value, client) {
  const payload = value?.payload;
  return client === "claude"
    ? Boolean(typeof value?.uuid === "string" && value.uuid.length <= 128 && !value.isMeta
      && ["user", "assistant"].includes(value.type))
    : client === "antigravity"
      ? Boolean(Number.isSafeInteger(value?.step_index) && value.status === "DONE"
        && ((value.type === "USER_INPUT" && value.source === "USER_EXPLICIT")
          || (value.type === "PLANNER_RESPONSE" && value.source === "MODEL")))
      : client === "codex"
        ? Boolean(value?.type === "response_item" && payload?.type === "message"
          && ["user", "assistant"].includes(payload.role) && payload.channel !== "analysis")
        : client === "pi" && value?.type === "message" && ["user", "assistant"].includes(value.message?.role);
}

function nativeIdentityOf(value, client) {
  if (client === "codex" && value?.type === "session_meta" && typeof value.payload?.id === "string") {
    return value.payload.id;
  }
  if (client === "claude" && typeof value?.sessionId === "string") return value.sessionId;
  if (client === "pi" && value?.type === "session" && typeof value.id === "string") return value.id;
  return null;
}

/**
 * Verify an explicit resume command points at the native session it names.
 * This runs before opening the database so a stale or mistyped command cannot
 * advance a different session's checkpoint.
 */
export async function validateCliTranscriptIdentity(transcriptPath, { client, nativeId, maxBytes = 256 * 1024 } = {}) {
  if (client === "antigravity") return null;
  if (!["codex", "claude", "pi"].includes(client)) throw new Error("Unsupported capture client");
  if (typeof nativeId !== "string" || !nativeId.trim()) throw new Error("Missing capture session identifier");
  const sourcePath = typeof transcriptPath === "string" && transcriptPath.startsWith("~/")
    ? path.join(os.homedir(), transcriptPath.slice(2)) : transcriptPath;
  const result = await readJsonlDelta(sourcePath, {
    maxBytes,
    maxRecordBytes: Math.min(maxBytes, 1024 * 1024),
    budgetMs: 250,
    maxRecords: 256,
  });
  const identities = result.records.map(({ value }) => nativeIdentityOf(value, client)).filter((id) => typeof id === "string");
  if (identities.some((id) => id !== nativeId)) {
    const error = new Error("SOURCE_SESSION_MISMATCH: capture session identifier does not match transcript identity");
    error.code = "SOURCE_SESSION_MISMATCH";
    throw error;
  }
  if (identities.length === 0) {
    const error = new Error("SOURCE_SESSION_ID_MISSING: capture transcript has no native session identity");
    error.code = "SOURCE_SESSION_ID_MISSING";
    throw error;
  }
  return identities[0];
}

function sourceRecords(turns) {
  return turns.flatMap((turn) => [
    { source_record_id: turn.source_record_id, source_revision: turn.source_revision },
    ...(turn.assistant_source_records ?? []).map(({ source_record_id, source_revision }) => ({ source_record_id, source_revision })),
  ]).filter((record) => record.source_record_id != null);
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
  next.abandonedSourceRecordIds = [];
  const accepted = [];
  for (const record of entries) {
    const sourceRecordId = `${record.offset}`;
    const value = record.value;
    if (!relevantRecord(value, client) || !rememberRecord(next, sourceRecordId)) continue;
    const sourceRevision = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    accepted.push({ ...value, sourceRecordId, sourceRevision });
  }

  if (client === "claude") {
    next.nodes = Object.assign(Object.create(null), next.nodes ?? {});
    next.nextNodeOrder ??= 0;
    next.activeNodeIds ??= [];
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
      }
      next.nodes[entry.uuid] = {
        uuid: entry.uuid,
        parentUuid: typeof entry.parentUuid === "string" && entry.parentUuid.length <= 128 ? entry.parentUuid : null,
        type: entry.type,
        role,
        text,
        timestamp: timestampOf(entry.timestamp),
        sourceRecordId: entry.sourceRecordId,
        sourceRevision: entry.sourceRevision,
        order: prior?.order ?? ++next.nextNodeOrder,
      };
      next.activeLeafUuid = entry.uuid;
    }
    if (accepted.length > 0) rebuildClaudeBranch(next);
    const keep = new Set(next.activeNodeIds);
    const ordered = Object.values(next.nodes).sort((left, right) => right.order - left.order);
    for (const node of ordered.slice(MAX_NODES)) if (!keep.has(node.uuid)) delete next.nodes[node.uuid];
    if (next.activeNodeIds.length > MAX_NODES) {
      next.activeNodeIds = next.activeNodeIds.slice(0, MAX_NODES);
      for (const uuid of Object.keys(next.nodes)) if (!next.activeNodeIds.includes(uuid)) delete next.nodes[uuid];
      const first = next.nodes[next.activeNodeIds.at(-1)];
      if (first) first.parentUuid = null;
    }
  } else if (client === "antigravity") {
    next.steps ??= {};
    delete next.stepRecordIds;
    for (const entry of accepted) {
      if (!Number.isInteger(entry.step_index) || entry.status !== "DONE") continue;
      let role = null;
      if (entry.type === "USER_INPUT" && entry.source === "USER_EXPLICIT") role = "user";
      if (entry.type === "PLANNER_RESPONSE" && entry.source === "MODEL") role = "assistant";
      if (!role || !antigravityText(entry.content).trim()) continue;
      const key = String(entry.step_index);
      const prior = next.steps[key];
      if (prior?.sourceRecordId && prior.sourceRevision !== entry.sourceRevision
        && !next.abandonedSourceRecordIds.includes(prior.sourceRecordId)) next.abandonedSourceRecordIds.push(prior.sourceRecordId);
      next.steps[key] = {
        step_index: entry.step_index,
        type: entry.type,
        source: entry.source,
        status: "DONE",
        content: antigravityText(entry.content),
        timestamp: timestampOf(entry.timestamp ?? entry.created_at),
        sourceRecordId: entry.sourceRecordId,
        sourceRevision: entry.sourceRevision,
      };
      const existingTurn = next.turns.find((turn) => turn.step_index === entry.step_index);
      if (existingTurn) {
        if (role === "user") {
          existingTurn.user_message = antigravityText(entry.content).trim();
          existingTurn.source_record_id = entry.sourceRecordId;
          if (Buffer.byteLength(existingTurn.user_message) + Buffer.byteLength(existingTurn.assistant_response) > MAX_TEXT_BYTES) {
            existingTurn.assistant_response = "";
            existingTurn.assistant_source_record_ids = [];
            existingTurn.assistant_source_records = [];
          }
        }
        else existingTurn.assistant_response = antigravityText(entry.content).trim();
        existingTurn.source_revision = turnRevision(existingTurn);
      } else if (role === "user") {
        addUserTurn(next, antigravityText(entry.content), entry.timestamp ?? entry.created_at, entry.sourceRecordId);
        next.turns.at(-1).step_index = entry.step_index;
      } else {
        const priorTurn = [...next.turns].reverse().find((turn) => (turn.step_index ?? -1) < entry.step_index);
        if (priorTurn) {
          const priorRecords = priorTurn.assistant_source_records ?? [];
          priorTurn.assistant_source_records = priorRecords.filter((record) => record.source_record_id !== prior?.sourceRecordId);
          addAssistantText({ turns: [priorTurn] }, antigravityText(entry.content), entry.sourceRecordId);
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
  // Evict only text captured by an earlier pass. A historical step revision
  // can occur near the start of the turn array and must survive this pass.
  const newIds = new Set(entries.map((record) => String(record.offset)));
  const newlyAccepted = (turn) => newIds.has(turn.source_record_id)
    || (turn.assistant_source_record_ids ?? []).some((id) => newIds.has(id));
  let textBytes = next.turns.reduce((bytes, turn) => bytes + Buffer.byteLength(turn.user_message)
    + Buffer.byteLength(turn.assistant_response), 0);
  while (next.turns.length > MAX_TURNS || textBytes > MAX_TEXT_BYTES) {
    const index = next.turns.findIndex((turn) => !newlyAccepted(turn));
    if (index < 0) break; // One indivisible accepted record may be up to 1 MiB.
    const [evicted] = next.turns.splice(index, 1);
    textBytes -= Buffer.byteLength(evicted.user_message) + Buffer.byteLength(evicted.assistant_response);
  }
  const retainedIds = new Set(next.turns.flatMap((turn) => [turn.user_message ? turn.source_record_id : null, ...(turn.assistant_source_record_ids ?? [])]));
  for (const node of Object.values(next.nodes ?? {})) if (!retainedIds.has(node.sourceRecordId)) node.text = "";
  for (const step of Object.values(next.steps ?? {})) if (!retainedIds.has(step.sourceRecordId)) step.content = "";
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
  nativeId = null,
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
  const requiresNativeIdentity = typeof nativeId === "string" && nativeId.trim() && client !== "antigravity";
  const observedIdentities = [];
  try {
    result = prior?.adapterState?.branchWork && sourcePath === prior.adapterState.sourcePath && !requiresNativeIdentity
      ? { records: [], diagnostics: [], checkpoint: readerCheckpoint, reset: false, bytesRead: 0 }
      : await readJsonlDelta(sourcePath, {
      checkpoint: readerCheckpoint,
      maxBytes,
      maxRecordBytes,
      budgetMs: Math.max(1, Math.floor(budgetMs * 0.6)),
      maxRecords: 8,
      maxAcceptedBytes: 128 * 1024,
      acceptRecord: (value) => relevantRecord(value, client),
      observeRecord: requiresNativeIdentity ? (value) => {
        const identity = nativeIdentityOf(value, client);
        if (identity !== null) observedIdentities.push(identity);
      } : null,
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
  if (requiresNativeIdentity) {
    const identities = observedIdentities;
    if (identities.length === 0 && prior?.adapterState?.nativeSessionId !== nativeId) {
      const error = new Error("SOURCE_SESSION_ID_MISSING: capture transcript has no native session identity");
      error.code = "SOURCE_SESSION_ID_MISSING";
      throw error;
    }
    if (identities.some((id) => id !== nativeId)) {
      const error = new Error("SOURCE_SESSION_MISMATCH: capture session identifier does not match transcript identity");
      error.code = "SOURCE_SESSION_MISMATCH";
      throw error;
    }
  }

  const generation = result.checkpoint.generation;
  const revision = `${generation}:${result.checkpoint.sourceSize}:${result.checkpoint.sourceMtimeMs}`;
  const previousTurns = prior?.adapterState?.turns ?? [];
  const previousState = result.reset ? {} : (prior?.adapterState ?? {});
  const adapterState = mergeTurns(previousState, result.records, client);
  if (requiresNativeIdentity) adapterState.nativeSessionId = nativeId;
  adapterState.sourcePath = sourcePath;
  adapterState.sourceCwd = typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null;
  adapterState.rescanning = result.reset || previousState.rescanning === true;
  const observedSources = sourceRecords(adapterState.turns);
  if (result.reset) {
    const observed = new Map(observedSources.map((record) => [record.source_record_id, record.source_revision]));
    for (const old of sourceRecords(previousTurns)) {
      if (observed.has(old.source_record_id) && observed.get(old.source_record_id) !== old.source_revision) {
        adapterState.abandonedSourceRecordIds.push(old.source_record_id);
      }
    }
  }
  const resetComplete = adapterState.rescanning && result.checkpoint.pendingBytes === 0;
  if (resetComplete) adapterState.rescanning = false;
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
    observedSources,
    captureGeneration: generation,
    sourceIdentity: result.checkpoint.sourceIdentity,
    captureCleanupCursor: adapterState.cleanupCursor ?? null,
    branchWork: adapterState.branchWork ?? null,
    previousLeafUuid: previousState.activeLeafUuid ?? null,
    activeLeafUuid: adapterState.activeLeafUuid ?? null,
    claudeRecords: client === "claude" ? result.records.map(({ value }) => adapterState.nodes?.[value.uuid]).filter(Boolean)
      .map(({ uuid, parentUuid, sourceRecordId, sourceRevision }) => ({ uuid, parentUuid, sourceRecordId, sourceRevision })) : [],
    resetComplete,
  };
  const changed = result.records.length > 0 || result.reset || resetComplete || adapterState.cleanupCursor != null || adapterState.branchWork != null;
  delete adapterState.turnHash;
  const health = healthFromDiagnostics(result.diagnostics, result.checkpoint.pendingBytes, prior);
  const checkpoint = checkpointFromResult(result, adapterState, prior, repository, revision, health);
  try {
    db.withSemanticMemoryTransaction(() => {
      db.saveIngestionCheckpoint(client, sessionId, checkpoint);
      if (changed && typeof capture === "function") {
        const captureState = capture({
          ...artifacts,
          turns: adapterState.turns,
        }, { revision, result });
        if (captureState && Object.hasOwn(captureState, "cleanupCursor")) {
          adapterState.cleanupCursor = captureState.cleanupCursor;
          adapterState.branchWork = captureState.branchWork ?? null;
          checkpoint.adapterState.cleanupCursor = adapterState.cleanupCursor;
          checkpoint.adapterState.branchWork = adapterState.branchWork;
          checkpoint.expectedCheckpointRevision = db.getIngestionCheckpoint(client, sessionId).checkpointRevision;
          db.saveIngestionCheckpoint(client, sessionId, checkpoint);
        }
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
    status: result.checkpoint.pendingBytes > 0 || adapterState.cleanupCursor != null || adapterState.branchWork != null ? "pending" : "captured",
    pending: result.checkpoint.pendingBytes > 0 || adapterState.cleanupCursor != null || adapterState.branchWork != null,
    records: result.records.length,
    turns: adapterState.turns.length,
    changed,
    reset: result.reset,
    checkpoint: db.getIngestionCheckpoint(client, sessionId),
    health,
  };
}
