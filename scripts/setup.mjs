import { createInterface } from "node:readline";
import { detectClients, selectClients, planSetup, applySetup, planRemove, applyRemove } from "../lib/setup.mjs";
import { checkRuntime, formatRuntimeDiagnostics } from "../lib/runtime.mjs";

try {
  const options = { yes: false, dryRun: false, remove: false, clients: null };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--yes") options.yes = true;
    else if (args[i] === "--dry-run") options.dryRun = true;
    else if (args[i] === "--remove") options.remove = true;
    else if (args[i] === "--clients" && args[i + 1] && !args[i + 1].startsWith("--")) options.clients = args[++i];
    else if (args[i] === "--help") {
      console.log("Usage: npm run setup -- [--clients copilot,pi,codex,claude,antigravity|all] [--remove] [--yes] [--dry-run]\nDetects clients on PATH and installs or removes Lore globally. Without flags, choose clients and confirm interactively.");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  if (process.platform === "win32") throw new Error("Windows is not supported.");
  if (!options.remove) {
    const runtime = await checkRuntime();
    if (!runtime.ok) throw new Error(formatRuntimeDiagnostics(runtime));
  }
  const clients = detectClients();
  const available = clients.filter((client) => client.executablePath);
  console.log("Lore setup — one memory, your choice of coding agents\n");
  for (const [index, client] of available.entries()) console.log(`  ${index + 1}. ${client.name} (${client.id}) — ${client.executablePath}`);
  const missing = clients.filter((client) => !client.executablePath);
  if (missing.length) console.log(`Not found on PATH: ${missing.map((client) => client.name).join(", ")}`);
  if (!available.length) throw new Error("No supported CLIs found. Install a supported client and make its executable available on PATH, then rerun setup.");
  if (options.yes && options.clients === null) throw new Error("--yes requires --clients; setup never selects clients silently.");
  // An async iterator keeps piped answers queued between prompts as well as
  // supporting a real terminal, without losing early confirmation input.
  const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = readline[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    process.stdout.write(prompt);
    const answer = await lines.next();
    return answer.done ? "" : answer.value;
  };
  try {
    const selection = options.clients ?? await ask("\nChoose clients (numbers or names, comma-separated; all; Enter cancels): ");
    const ids = selectClients(selection, clients);
    if (!ids.length) { console.log("Cancelled. No changes made."); }
    else {
      const plan = options.remove ? planRemove(ids) : planSetup(ids);
      console.log(`\nEnable shared Lore configuration: ${plan.paths.configPath}`);
      for (const target of plan.targets) console.log(`  ${target.id}: ${target.target}`);
      if (options.remove) console.log("Only Lore-owned hooks and runtime copies with intact ownership metadata are eligible; memories, configuration, unrelated hooks, and modified content are preserved.");
      else {
        console.log("Existing settings are merged; replaced files/installations are backed up. Keep this checkout and Node installation in place for native hooks.");
        console.log("Recalled memories become context for each client's configured model. No experimental rollout flags are enabled by setup.");
      }
      if (options.dryRun) console.log("Dry run. No changes made.");
      else if (!options.yes && !/^y(?:es)?$/iu.test((await ask("Install and enable Lore for these clients? [y/N] ")).trim())) console.log("Cancelled. No changes made.");
      else {
        const backup = options.remove ? applyRemove(plan) : applySetup(plan);
        console.log(options.remove ? "\nLore removal complete. Preserved data and settings were verified." : "\nLore installed. Configuration and installed files verified.");
        if (backup) console.log(`Recoverable backups: ${backup}`);
        if (!options.remove) {
          if (ids.includes("copilot")) console.log("Copilot: restart for extension discovery.");
          if (ids.includes("pi")) console.log("Pi: /reload or restart; check /lore status. Node must remain on PATH (or set LORE_NODE).");
          if (ids.includes("codex")) console.log("Codex: restart, then review and trust Lore in /hooks. Host trust and managed settings still apply.");
          if (ids.includes("claude")) console.log("Claude Code: restart; approve hooks if prompted.");
          if (ids.includes("antigravity")) console.log('Antigravity: restart with agy --add-dir "/absolute/project"; /hooks should list lore.');
          console.log("Detection confirms executables, not host-version compatibility. See docs/cli-integrations.md for verified versions and host limits.");
        }
      }
    }
  } finally { readline.close(); }
} catch (error) {
  console.error(`Lore setup: ${error.message}`);
  process.exitCode = 1;
}
