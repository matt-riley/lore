// Native hook and direct-tool entrypoint; no daemon, network, or MCP required.
import { runCliHook, runCliTool } from "./lib/cli-runtime.mjs";

const [mode, clientOrTool, event] = process.argv.slice(2);
const neutral = clientOrTool === "antigravity" && event === "Stop" ? { decision: "stop" } : {};
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Hook input exceeds 1 MiB");
  }
  const args = JSON.parse(input || "{}");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected a JSON object on stdin");
  if (mode === "hook") {
    process.stdout.write(`${JSON.stringify(await runCliHook(clientOrTool, event, args))}\n`);
  } else if (mode === "tool") {
    process.stdout.write(`${await runCliTool(clientOrTool, args)}\n`);
  } else {
    throw new Error("Usage: node lore-cli.mjs hook <codex|claude|antigravity> <event>, or tool <name>; JSON input on stdin");
  }
} catch (error) {
  console.error(`[lore] ${error.message}`);
  if (mode === "hook") process.stdout.write(`${JSON.stringify(neutral)}\n`);
  else process.exitCode = 1;
}
