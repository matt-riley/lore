// Pi's Bun extension talks to this Node child over JSON lines. Keep the
// database implementation behind the runtime preflight: an unsupported Node
// process must still answer requests with protocol-shaped errors.
import { checkRuntime, formatRuntimeDiagnostics } from "./lib/runtime.mjs";

const runtime = await checkRuntime();
if (!runtime.ok) {
  const message = formatRuntimeDiagnostics(runtime);
  console.error(`[lore-server] runtime unavailable: ${message}`);
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    try {
      const request = JSON.parse(line);
      process.stdout.write(`${JSON.stringify({ id: request?.id, ok: false, error: message })}\n`);
    } catch {
      // Match the implementation's behavior for malformed protocol input.
    }
  });
} else {
  await import("./lore-server-runtime.mjs");
}
