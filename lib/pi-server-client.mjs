import { spawn as defaultSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

function asError(error, fallback) {
  return error instanceof Error ? error : new Error(error ? String(error) : fallback);
}

function waitFor(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Create a JSON-lines client for the node process backing the pi adapter.
 * The client owns one child at a time and can restart after that child dies.
 */
export function createPiServerClient({
  command,
  args = [],
  env,
  cwd,
  spawnImpl = defaultSpawn,
  requestTimeoutMs = 15_000,
  closeTimeoutMs = 1_000,
} = {}) {
  let active = null;
  let startPromise = null;

  function rejectPending(handle, error) {
    for (const pending of handle.pending.values()) {
      pending.reject(error);
    }
    handle.pending.clear();
  }

  function markDead(handle, error) {
    if (handle.dead) {
      return;
    }
    handle.dead = true;
    if (active === handle) {
      active = null;
    }
    const reason = asError(error, "lore server stopped");
    rejectPending(handle, reason);
    handle.resolveExit?.();
  }

  function parseOutput(handle, chunk) {
    handle.output += handle.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newline;
    while ((newline = handle.output.indexOf("\n")) >= 0) {
      const line = handle.output.slice(0, newline);
      handle.output = handle.output.slice(newline + 1);
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        // A server diagnostic must not prevent later protocol responses.
        continue;
      }
      const pending = handle.pending.get(message.id);
      if (!pending) {
        continue;
      }
      handle.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error ?? "lore server error"));
      }
    }
  }

  function attachProcess(handle) {
    const { proc } = handle;
    proc.on("error", (error) => {
      markDead(handle, asError(error, "lore server process error"));
    });
    proc.on("exit", (code, signal) => {
      if (!handle.dead) {
        markDead(handle, new Error(
          code === 0
            ? "lore server exited"
            : `lore server exited before completing request (code=${code ?? "?"}, signal=${signal ?? "?"})`,
        ));
      }
      handle.resolveExit?.();
    });
    proc.on("close", () => {
      if (!handle.dead) {
        markDead(handle, new Error("lore server closed"));
      }
      handle.resolveExit?.();
    });
    proc.stdin?.on("error", (error) => {
      markDead(handle, asError(error, "lore server stdin error"));
    });
    proc.stdout?.on("data", (chunk) => parseOutput(handle, chunk));
    proc.stdout?.on("end", () => {
      handle.output += handle.decoder.end();
    });
  }

  function requestOn(handle, method, params, timeoutMs, allowClosing = false) {
    return new Promise((resolve, reject) => {
      if (handle.dead || (!allowClosing && handle.closing)) {
        reject(new Error("lore server not running"));
        return;
      }
      const id = handle.nextId++;
      const timer = setTimeout(() => {
        if (handle.pending.delete(id)) {
          reject(new Error(`lore server timeout (${method})`));
        }
      }, timeoutMs);
      handle.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        if (!handle.proc.stdin || handle.proc.stdin.destroyed) {
          throw new Error("lore server stdin is closed");
        }
        handle.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        handle.pending.delete(id);
        reject(error);
      }
    });
  }

  async function start() {
    if (active?.closing) {
      await active.closePromise;
      return start();
    }
    if (active && !active.dead && active.ready) {
      return active.readyResult;
    }
    if (startPromise) {
      return startPromise;
    }
    startPromise = (async () => {
      let handle;
      try {
        const proc = spawnImpl(command, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "inherit"],
        });
        handle = {
          proc,
          decoder: new StringDecoder("utf8"),
          output: "",
          nextId: 1,
          pending: new Map(),
          dead: false,
          closing: false,
          ready: false,
          readyResult: null,
          resolveExit: null,
        };
        handle.exitPromise = new Promise((resolve) => {
          handle.resolveExit = resolve;
        });
        active = handle;
        attachProcess(handle);
        const result = await requestOn(handle, "status", {}, requestTimeoutMs);
        if (handle.dead) {
          throw new Error("lore server exited before completing request (status)");
        }
        handle.ready = true;
        handle.readyResult = result;
        return result;
      } catch (error) {
        if (handle) {
          markDead(handle, asError(error, "lore server failed to start"));
          try {
            handle.proc.kill();
          } catch {
            // The child may already have exited.
          }
        }
        throw asError(error, "lore server failed to start");
      }
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function close() {
    const handle = active;
    if (!handle) {
      return;
    }
    if (handle.closePromise) {
      return handle.closePromise;
    }
    handle.closePromise = (async () => {
      handle.closing = true;
      try {
        // The server's close method acknowledges the request; EOF is what
        // makes readline close and lets the server close its database.
        await requestOn(handle, "close", {}, closeTimeoutMs, true);
      } catch {
        // Continue to stdin EOF so a partially responsive server can drain.
      }
      try {
        if (handle.proc.stdin && !handle.proc.stdin.destroyed) {
          handle.proc.stdin.end();
        }
      } catch {
        // The process may have exited between the request and EOF.
      }
      await waitFor(handle.exitPromise, closeTimeoutMs);
      if (!handle.dead) {
        try {
          handle.proc.kill();
        } catch {
          // The process may have exited after the timeout.
        }
        markDead(handle, new Error("lore server stopped"));
      }
      if (active === handle) {
        active = null;
      }
    })();
    return handle.closePromise;
  }

  return {
    start,
    request(method, params = {}, timeoutMs = requestTimeoutMs) {
      const handle = active;
      if (!handle) {
        return Promise.reject(new Error("lore server not running"));
      }
      return requestOn(handle, method, params, timeoutMs);
    },
    close,
    isAlive() {
      return Boolean(active && !active.dead && !active.closing && active.ready);
    },
  };
}
