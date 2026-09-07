// Native hook and direct-tool entrypoint; no daemon, network, or MCP required.
// Keep database imports behind the runtime preflight so unsupported hosts can
// still receive the hook protocol's neutral response.
import { checkRuntime, formatRuntimeDiagnostics } from "./lib/core/runtime.mjs";

const argv = process.argv.slice(2);
const [mode, clientOrTool, event] = argv;
const neutral = clientOrTool === "antigravity" && event === "Stop" ? { decision: "stop" } : {};
try {
  let bytesReceived = 0;
  const chunks = [];
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) {
      bytesReceived += chunk.length;
      if (bytesReceived > 1024 * 1024) throw new Error("Hook input exceeds 1 MiB");
      chunks.push(chunk);
    }
  }
  const input = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "{}";
  const args = JSON.parse(input.trim() || "{}");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected a JSON object on stdin");
  const runtime = await checkRuntime();
  if (!runtime.ok) throw new Error(formatRuntimeDiagnostics(runtime));
  const { runCliHook, runCliTool, runCliCapture } = await import("./lib/clients/cli-runtime.mjs");
  if (mode === "hook") {
    process.stdout.write(`${JSON.stringify(await runCliHook(clientOrTool, event, args))}\n`);
  } else if (mode === "tool") {
    process.stdout.write(`${await runCliTool(clientOrTool, args)}\n`);
  } else if (mode === "capture" && clientOrTool === "--resume") {
    const clientIndex = argv.indexOf("--client");
    const sessionIndex = argv.indexOf("--session");
    const client = clientIndex >= 0 ? argv[clientIndex + 1] : null;
    const session = sessionIndex >= 0 ? argv[sessionIndex + 1] : null;
    if (!client || !session) throw new Error("Usage: node lore-cli.mjs capture --resume --client <client> --session <native-id>");
    process.stdout.write(`${JSON.stringify(await runCliCapture(client, session, args))}\n`);
  } else {
    throw new Error("Usage: node lore-cli.mjs hook <codex|claude|antigravity> <event>, capture --resume --client <client> --session <native-id>, or tool <name>; JSON input on stdin");
  }
} catch (error) {
  console.error(`[lore] ${error.message}`);
  if (mode === "hook") process.stdout.write(`${JSON.stringify(neutral)}\n`);
  else process.exitCode = 1;
}
