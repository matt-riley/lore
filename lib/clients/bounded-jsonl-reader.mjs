import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import path from "node:path";

const CHECKPOINT_PROBE_BYTES = 4096;

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function appendTail(existing, bytes, limit) {
  if (limit <= 0 || bytes.length === 0) return existing;
  const combined = Buffer.concat([existing, bytes]);
  return combined.length > limit ? combined.subarray(combined.length - limit) : combined;
}

// Checkpoints contain transcript fragments and must receive the same protection
// as the source transcript. Diagnostics deliberately contain no source text.
export async function readJsonlDelta(file, {
  checkpoint = null,
  maxBytes = 4 * 1024 * 1024,
  maxRecordBytes = 1024 * 1024,
  budgetMs = 250,
  maxRecords = Number.MAX_SAFE_INTEGER,
  acceptRecord = null,
  maxAcceptedBytes = Number.MAX_SAFE_INTEGER,
} = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Transcript path must be absolute");
  for (const [name, value] of Object.entries({ maxBytes, maxRecordBytes, budgetMs, maxRecords, maxAcceptedBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const source = await handle.stat();
    if (!source.isFile()) throw new Error("Transcript source must be a regular file");
    const sourceIdentity = `${source.dev}:${source.ino}`;
    // Compare exactly the bytes present at the previous checkpoint. A short
    // prefix must not grow merely because the source was appended.
    const probeLimit = Math.min(CHECKPOINT_PROBE_BYTES, Math.floor(maxBytes / 4));
    const prefixLength = Math.min(checkpoint?.sourcePrefixLength || CHECKPOINT_PROBE_BYTES, source.size, probeLimit);
    let probeBytes = 0;
    let sourcePrefixHash = null;
    if (prefixLength > 0) {
      const prefix = Buffer.alloc(prefixLength);
      const prefixRead = await handle.read(prefix, 0, prefixLength, 0);
      probeBytes = prefixRead.bytesRead;
      sourcePrefixHash = hashBytes(prefix.subarray(0, prefixRead.bytesRead));
    }
    const priorOffset = Number.isSafeInteger(checkpoint?.offset) ? checkpoint.offset : null;
    const priorProbeLength = Number.isSafeInteger(checkpoint?.sourceCheckpointLength) && checkpoint.sourceCheckpointLength > 0
      ? Math.min(checkpoint.sourceCheckpointLength, probeLimit)
      : Math.min(probeLimit, priorOffset ?? 0, source.size);
    let checkpointProbe = Buffer.alloc(0);
    if (priorOffset !== null && priorOffset > 0 && source.size >= priorOffset && priorProbeLength > 0) {
      const probe = Buffer.alloc(priorProbeLength);
      const probeRead = await handle.read(probe, 0, priorProbeLength, priorOffset - priorProbeLength);
      checkpointProbe = probe.subarray(0, probeRead.bytesRead);
      probeBytes += probeRead.bytesRead;
    }
    const checkpointProbeVerified = Boolean(
      checkpoint?.sourceCheckpointHash
      && checkpoint?.sourceCheckpointOffset === priorOffset
      && checkpoint?.sourceCheckpointLength === priorProbeLength
      && checkpointProbe.length === priorProbeLength,
    );
    const checkpointProbeMatches = checkpointProbeVerified
      && hashBytes(checkpointProbe) === checkpoint.sourceCheckpointHash;
    const reset = Boolean(checkpoint && (
      checkpoint.sourceIdentity !== sourceIdentity ||
      source.size < checkpoint.offset ||
      source.size < checkpoint.sourceSize ||
      (source.size === checkpoint.sourceSize && source.mtimeMs !== checkpoint.sourceMtimeMs) ||
      (checkpoint.sourcePrefixHash && (checkpoint.sourcePrefixLength ?? Math.min(4096, checkpoint.sourceSize)) === prefixLength
        && checkpoint.sourcePrefixHash !== sourcePrefixHash) ||
      (checkpointProbeVerified && !checkpointProbeMatches)
    ));
    const previous = reset ? null : checkpoint;
    let checkpointTail = reset ? Buffer.alloc(0) : checkpointProbe;
    let offset = previous?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid transcript checkpoint offset");
    let partial = Buffer.from(previous?.partialRecord ?? "", "base64");
    if (partial.length > maxRecordBytes) throw new Error("Transcript checkpoint exceeds record limit");
    let discarding = previous?.discarding ?? false;
    let recordOffset = previous?.recordOffset ?? offset - partial.length;
    const records = [];
    let acceptedBytes = 0;
    let deferredOffset = null;
    const diagnostics = [];
    const started = performance.now();
    let bytesRead = probeBytes;
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
    const readBudget = maxBytes - probeLimit;
    while (offset < source.size && bytesRead < readBudget && performance.now() - started < budgetMs) {
      const length = Math.min(buffer.length, readBudget - bytesRead, source.size - offset);
      const read = await handle.read(buffer, 0, length, offset);
      if (!read.bytesRead) break;
      let start = 0;
      while (start < read.bytesRead && records.length < maxRecords && acceptedBytes < maxAcceptedBytes) {
        const newline = buffer.indexOf(10, start);
        const complete = newline >= 0 && newline < read.bytesRead;
        const end = complete ? newline : read.bytesRead;
        const part = buffer.subarray(start, end);
        if (!discarding) {
          if (partial.length + part.length > maxRecordBytes) {
            diagnostics.push({ code: "record_too_large", offset: recordOffset });
            partial = Buffer.alloc(0);
            discarding = true;
          } else {
            partial = Buffer.concat([partial, part]);
          }
        }
        if (complete) {
          if (!discarding && partial.toString("utf8").trim()) {
            try {
              const value = JSON.parse(partial.toString("utf8"));
              if (!acceptRecord || acceptRecord(value)) {
                if (records.length > 0 && acceptedBytes + partial.length > maxAcceptedBytes) {
                  deferredOffset = recordOffset;
                  break;
                }
                acceptedBytes += partial.length;
                records.push({ value, offset: recordOffset });
              }
            } catch {
              diagnostics.push({ code: "malformed_record", offset: recordOffset });
            }
          }
          partial = Buffer.alloc(0);
          discarding = false;
          recordOffset = offset + end + 1;
        }
        start = end + (complete ? 1 : 0);
      }
      const consumed = Math.min(start, read.bytesRead);
      checkpointTail = appendTail(checkpointTail, buffer.subarray(0, consumed), probeLimit);
      offset += consumed;
      bytesRead += read.bytesRead;
      if (deferredOffset !== null) {
        offset = deferredOffset;
        recordOffset = deferredOffset;
        partial = Buffer.alloc(0);
        // A whole record may have been read past the deferred offset before
        // the accepted-byte cap fired. Rebuild the rolling tail at the
        // returned checkpoint instead of hashing bytes beyond that offset.
        const deferredProbeLength = Math.min(probeLimit, deferredOffset, source.size);
        if (deferredProbeLength > 0) {
          const probe = Buffer.alloc(deferredProbeLength);
          const probeRead = await handle.read(probe, 0, deferredProbeLength, deferredOffset - deferredProbeLength);
          checkpointTail = probe.subarray(0, probeRead.bytesRead);
          bytesRead += probeRead.bytesRead;
        } else {
          checkpointTail = Buffer.alloc(0);
        }
        break;
      }
      if (records.length >= maxRecords || acceptedBytes >= maxAcceptedBytes) break;
      await setImmediate();
    }
    const sourceCheckpointHash = checkpointTail.length > 0 ? hashBytes(checkpointTail) : null;
    return {
      records, diagnostics, bytesRead, reset,
      checkpoint: {
        sourceIdentity,
        sourceSize: source.size,
        sourceMtimeMs: source.mtimeMs,
        sourcePrefixHash,
        sourcePrefixLength: prefixLength,
        sourceCheckpointHash,
        sourceCheckpointOffset: sourceCheckpointHash ? offset : null,
        sourceCheckpointLength: sourceCheckpointHash ? checkpointTail.length : 0,
        generation: previous?.generation ?? randomUUID(),
        offset,
        recordOffset,
        partialRecord: partial.toString("base64"),
        discarding,
        pendingBytes: Math.max(0, source.size - offset) + partial.length,
      },
    };
  } finally {
    await handle.close();
  }
}
