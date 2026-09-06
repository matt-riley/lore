// Opt-in live verification: uses installed/authenticated CLIs and synthetic data.
// Keeps isolated artifacts; Antigravity's opt-in global probe is temporary.
import { mkdtemp, writeFile, mkdir, readFile, unlink, realpath, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCliHookConfig, shellQuote } from "../lib/cli-hook-config.mjs";

let activeChild;
const exec = (command, args, options) => new Promise((resolve, reject) => {
  const child = execFile(command, args, options, (error, stdout, stderr) => {
    if (activeChild === child) activeChild = null;
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
  activeChild = child;
  child.stdin.end();
});
const client = process.argv[2];
const globalProbe = client === "antigravity" && process.argv.includes("--global-hook-probe");
const entry = fileURLToPath(new URL("../lore-cli.mjs", import.meta.url));
const fragment = buildCliHookConfig(client, { nodePath: process.execPath, entryPath: entry });
const directory = await mkdtemp(path.join(os.tmpdir(), `lore-live-${client}-`));
await exec("git", ["init", "--quiet", directory], {});
const loreHome = path.join(directory, "data");
await mkdir(loreHome);
const config = path.join(loreHome, "lore.json");
await writeFile(config, JSON.stringify({ enabled: true }));
const env = { ...process.env, ...(client === "antigravity" && !globalProbe ? { HOME: directory } : {}), LORE_HOME: loreHome, LORE_CONFIG: config, LORE_ENABLED: "true", LORE_REPOSITORY: "lore-live-verification" };
const word = `quartz-${randomUUID().slice(0, 8)}`;
const seed = (name, args) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [entry, "tool", name], { env, cwd: directory }, (error, stdout) => error ? reject(error) : resolve(stdout));
  child.stdin.end(JSON.stringify(args));
});
await seed("lore_onboard", { userName: "Verifier" });
await seed("memory_save", { content: `My quartzanchor verification word is ${word}.`, type: "user_preference" });
const relative = { codex: ".codex/hooks.json", claude: ".claude/settings.local.json", antigravity: ".gemini/config/hooks.json" }[client];
const target = path.join(directory, relative);
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(fragment));
let cleanupProbe = async () => {};
if (globalProbe) {
  const shared = path.join(os.homedir(), ".gemini", "config", "hooks.json");
  const stat = await lstat(shared).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (stat && !stat.isFile()) throw new Error("Live hook probe requires a regular shared hooks file, not a symlink");
  const original = await readFile(shared, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  const current = original === null ? {} : JSON.parse(original);
  const key = `lore-verification-${randomUUID()}`;
  const wrapper = path.join(directory, "probe.mjs");
  // Global registration is temporary, but the hook only acts on this exact
  // synthetic workspace. Other conversations receive a neutral response.
  await writeFile(wrapper, `import { readFileSync, realpathSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const event = process.argv[2];
const payload = JSON.parse(readFileSync(0, "utf8"));
const matches = (payload.workspacePaths?.length ? payload.workspacePaths : [process.cwd()]).some((p) => { try { return realpathSync(p) === ${JSON.stringify(await realpath(directory))}; } catch { return false; } });
let output = JSON.stringify(event === "Stop" ? {decision:"stop"} : {});
if (matches) {
  const child = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(entry)}, "hook", "antigravity", event], { input: JSON.stringify(payload), encoding: "utf8", env: {...process.env, LORE_HOME:${JSON.stringify(loreHome)}, LORE_CONFIG:${JSON.stringify(config)}, LORE_ENABLED:"true", LORE_REPOSITORY:"lore-live-verification"} });
  output = child.stdout || output;
  appendFileSync(${JSON.stringify(path.join(directory, "hook-events.jsonl"))}, JSON.stringify({event, payload, output, stderr: child.stderr}) + "\\n");
}
process.stdout.write(output + "\\n");
`);
  const hooks = structuredClone(fragment.lore);
  for (const [event, handlers] of Object.entries(hooks)) {
    for (const group of handlers) {
      for (const handler of group.hooks ?? [group]) handler.command = `${shellQuote(process.execPath)} ${shellQuote(wrapper)} ${event}`;
    }
  }
  current[key] = hooks;
  await mkdir(path.dirname(shared), { recursive: true });
  await writeFile(shared, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  const removeProbe = async () => {
    const latest = JSON.parse(await readFile(shared, "utf8"));
    delete latest[key];
    const baseline = original === null ? {} : JSON.parse(original);
    if (JSON.stringify(latest) === JSON.stringify(baseline)) {
      if (original === null) await unlink(shared);
      else await writeFile(shared, original);
    } else await writeFile(shared, JSON.stringify(latest, null, 2) + "\n");
  };
  let cleanupPromise;
  cleanupProbe = () => cleanupPromise ??= removeProbe();
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, async () => {
    activeChild?.kill(signal);
    await cleanupProbe();
    process.exit(code);
  });
}
const prompt = "What is my quartzanchor verification word? Use the memory context already provided to you. Reply with only the word, do not call tools, do not read files, and do not guess if unavailable.";
const toml = (value) => Array.isArray(value) ? `[${value.map(toml).join(", ")}]`
  : value !== null && typeof value === "object" ? `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(", ")} }` : JSON.stringify(value);
const command = { codex: "codex", claude: "claude", antigravity: "agy" }[client];
const args = {
  codex: ["exec", "--ignore-user-config", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "-s", "read-only", "-c", `hooks=${toml(fragment.hooks)}`, "--json", prompt],
  claude: ["--setting-sources", "", "--settings", target, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "", "-p", prompt],
  antigravity: ["--add-dir", directory, "--mode", "plan", "--output-format", "json", "--print-timeout", "90s", "--print", prompt],
}[client];
console.log(`Live ${client} verification artifacts: ${directory}`);
try {
  const result = await exec(command, args, { cwd: directory, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(path.join(directory, "stdout.txt"), result.stdout);
  await writeFile(path.join(directory, "stderr.txt"), result.stderr);
  const db = new DatabaseSync(path.join(loreHome, "lore.db"), { readOnly: true });
  const count = db.prepare("SELECT count(*) AS n FROM episode_digest WHERE session_id LIKE ?").get(`${client}:%`).n;
  db.close();
  const recalled = result.stdout.includes(word);
  console.log(JSON.stringify({ client, recalled, capturedSessions: count }));
  if (!recalled || count < 1) process.exitCode = 1;
} catch (error) {
  await writeFile(path.join(directory, "stdout.txt"), error.stdout ?? "");
  await writeFile(path.join(directory, "stderr.txt"), error.stderr ?? error.message);
  console.error(`Live verification failed: ${error.message.slice(0, 300)}`);
  process.exitCode = 1;
} finally { await cleanupProbe(); }
