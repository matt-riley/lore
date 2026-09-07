import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";

// Checkpoints contain transcript fragments and must receive the same protection
// as the source transcript. Diagnostics deliberately contain no source text.
export async function readJsonlDelta(file, {
  checkpoint = null,
  maxBytes = 4 * 1024 * 1024,
  maxRecordBytes = 1024 * 1024,
  budgetMs = 250,
} = {}) {
  for (const [name, value] of Object.entries({ maxBytes, maxRecordBytes, budgetMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const source = await handle.stat();
    if (!source.isFile()) throw new Error("Transcript source must be a regular file");
    const sourceIdentity = `${source.dev}:${source.ino}`;
    const reset = Boolean(checkpoint && (
      checkpoint.sourceIdentity !== sourceIdentity ||
      source.size < checkpoint.offset ||
      source.size < checkpoint.sourceSize ||
      (source.size === checkpoint.sourceSize && source.mtimeMs !== checkpoint.sourceMtimeMs)
    ));
    const previous = reset ? null : checkpoint;
    let offset = previous?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid transcript checkpoint offset");
    let partial = Buffer.from(previous?.partialRecord ?? "", "base64");
    if (partial.length > maxRecordBytes) throw new Error("Transcript checkpoint exceeds record limit");
    let discarding = previous?.discarding ?? false;
    let recordOffset = previous?.recordOffset ?? offset - partial.length;
    const records = [];
    const diagnostics = [];
    const started = performance.now();
    let bytesRead = 0;
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
    while (offset < source.size && bytesRead < maxBytes && performance.now() - started < budgetMs) {
      const length = Math.min(buffer.length, maxBytes - bytesRead, source.size - offset);
      const read = await handle.read(buffer, 0, length, offset);
      if (!read.bytesRead) break;
      let start = 0;
      while (start < read.bytesRead) {
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
              records.push({ value: JSON.parse(partial.toString("utf8")), offset: recordOffset });
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
      offset += read.bytesRead;
      bytesRead += read.bytesRead;
      await setImmediate();
    }
    return {
      records, diagnostics, bytesRead, reset,
      checkpoint: {
        sourceIdentity,
        sourceSize: source.size,
        sourceMtimeMs: source.mtimeMs,
        generation: previous?.generation ?? randomUUID(),
        offset,
        recordOffset,
        partialRecord: partial.toString("base64"),
        discarding,
        pendingBytes: Math.max(0, source.size - offset),
      },
    };
  } finally {
    await handle.close();
  }
}
