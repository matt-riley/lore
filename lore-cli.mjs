#!/usr/bin/env node
// Native hook, direct-tool, and human CLI entrypoint; no daemon, network, or MCP required.
// Keep database imports behind the runtime preflight so unsupported hosts can
// still receive the hook protocol's neutral response.
import { checkRuntime, formatRuntimeDiagnostics } from "./lib/core/runtime.mjs";

const argv = process.argv.slice(2);
const [mode, clientOrTool, event] = argv;
const isProtocol = mode === "hook" || mode === "tool" || (mode === "capture" && clientOrTool === "--resume");
const neutral = clientOrTool === "antigravity" && event === "Stop" ? { decision: "stop" } : {};

function jsonLooksLikeObject(value) {
  const text = String(value ?? "").trim();
  return text.startsWith("{") || text.startsWith("[");
}

function needsStdinJsonPayload(tokens) {
  const index = tokens.findIndex((token) => token === "--json" || token.startsWith("--json="));
  if (index === -1) {
    return false;
  }
  if (tokens[index].startsWith("--json=")) {
    return !jsonLooksLikeObject(tokens[index].slice("--json=".length));
  }
  const next = tokens[index + 1];
  if (jsonLooksLikeObject(next)) {
    return false;
  }
  // `--json` as the last token (or followed by another flag) means stdin; a
  // following word is positional content that happens to mention the flag.
  return next === undefined || String(next).startsWith("--");
}

function injectStdinJsonPayload(tokens, raw) {
  const next = tokens.slice();
  const index = next.findIndex((token) => token === "--json" || token.startsWith("--json="));
  if (index === -1) {
    return next;
  }
  if (next[index].startsWith("--json=")) {
    next[index] = `--json=${raw}`;
    return next;
  }
  next.splice(index + 1, 0, raw);
  return next;
}

async function readStdinLimited(maxBytes = 1024 * 1024) {
  if (process.stdin.isTTY) {
    return "";
  }
  let bytesReceived = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytesReceived += chunk.length;
    if (bytesReceived > maxBytes) {
      throw new Error("Hook input exceeds 1 MiB");
    }
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
}

function resolveCliClient(env = process.env) {
  const value = String(env.LORE_CLIENT ?? "").trim();
  return ["copilot", "pi", "codex", "claude", "antigravity"].includes(value) ? value : "copilot";
}

try {
  if (isProtocol) {
    const input = (await readStdinLimited()).trim() || "{}";
    const args = JSON.parse(input);
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Expected a JSON object on stdin");
    }
    const runtime = await checkRuntime();
    if (!runtime.ok) {
      throw new Error(formatRuntimeDiagnostics(runtime));
    }
    const { runCliHook, runCliTool, runCliCapture } = await import("./lib/clients/cli-runtime.mjs");
    if (mode === "hook") {
      process.stdout.write(`${JSON.stringify(await runCliHook(clientOrTool, event, args))}\n`);
    } else if (mode === "tool") {
      process.stdout.write(`${await runCliTool(clientOrTool, args)}\n`);
    } else {
      const clientIndex = argv.indexOf("--client");
      const sessionIndex = argv.indexOf("--session");
      const client = clientIndex >= 0 ? argv[clientIndex + 1] : null;
      const session = sessionIndex >= 0 ? argv[sessionIndex + 1] : null;
      if (!client || !session) {
        throw new Error("Usage: node lore-cli.mjs capture --resume --client <client> --session <native-id>");
      }
      process.stdout.write(`${JSON.stringify(await runCliCapture(client, session, args))}\n`);
    }
  } else {
    const { parseLoreArgv, dispatchSlash } = await import("./lib/runtime/slash-dispatch.mjs");
    let tokens = argv.slice();
    if (needsStdinJsonPayload(tokens)) {
      if (process.stdin.isTTY) {
        throw new Error("lore: --json requires a JSON object argument or stdin");
      }
      const raw = (await readStdinLimited()).trim();
      if (!raw || !jsonLooksLikeObject(raw)) {
        throw new Error("lore: --json requires a JSON object on stdin or as an argument");
      }
      tokens = injectStdinJsonPayload(tokens, raw);
    }
    const parsed = parseLoreArgv(tokens);
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    const runtime = await checkRuntime();
    if (!runtime.ok) {
      throw new Error(formatRuntimeDiagnostics(runtime));
    }
    const { createLoreSession } = await import("./lib/runtime/lore-runtime.mjs");
    const session = await createLoreSession({
      client: resolveCliClient(),
      surface: "cli",
      cwd: process.cwd(),
      sessionId: `cli:${process.pid}`,
    });
    try {
      if (!session.initialized) {
        throw session.lastError ?? new Error("lore unavailable");
      }
      const text = await dispatchSlash(tokens, (name, args, extra) => session.dispatchTool(name, args, extra), {
        surface: "cli",
        sessionId: session.sessionId,
      });
      const output = String(text ?? "");
      process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    } finally {
      session.close();
    }
  }
} catch (error) {
  console.error(`[lore] ${error.message}`);
  if (mode === "hook") {
    process.stdout.write(`${JSON.stringify(neutral)}\n`);
  } else {
    process.exitCode = 1;
  }
}
