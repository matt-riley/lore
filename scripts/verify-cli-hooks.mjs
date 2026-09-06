// Bounded native-hook certification. Data and hook files stay in temporary
// directories; statuses distinguish pass, fail, and unauthenticated pending.
import { mkdtemp, writeFile, mkdir, readFile, unlink, realpath, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCliHookConfig } from "../lib/cli-hook-config.mjs";

let activeChild;
const exec = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(command, args, options, (error, stdout, stderr) => {
    if (activeChild === child) activeChild = null;
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
  activeChild = child;
  child.stdin.end(options.input ?? "");
});

function parseArgs(argv) {
  const [client, ...rest] = argv;
  const options = { json: false, globalProbe: false, testHome: null, sessions: 2 };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--global-hook-probe") options.globalProbe = true;
    else if (arg === "--test-home" && rest[i + 1] && !rest[i + 1].startsWith("--")) options.testHome = path.resolve(rest[++i]);
    else if (arg === "--sessions" && /^\d+$/.test(rest[i + 1] ?? "")) options.sessions = Math.min(4, Math.max(1, Number(rest[++i])));
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!["codex", "claude", "antigravity"].includes(client)) throw new Error("Client must be codex, claude, or antigravity");
  if (options.globalProbe && client !== "antigravity") throw new Error("--global-hook-probe is only valid for Antigravity");
  return { client, options };
}

const entry = fileURLToPath(new URL("../lore-cli.mjs", import.meta.url));
const repoRoot = path.dirname(path.dirname(entry));
const privateError = (error) => String(error?.message ?? error).replaceAll(/\s+/gu, " ").slice(0, 240);
const status = (state, detail = undefined) => ({ status: state, ...(detail ? { detail } : {}) });
const toml = (value) => Array.isArray(value) ? `[${value.map(toml).join(", ")}]`
  : value !== null && typeof value === "object" ? `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(", ")} }` : JSON.stringify(value);

async function main({ client, options }) {
  if (options.globalProbe) {
    if (!options.testHome) throw new Error("Antigravity global probe requires --test-home <dedicated-directory>");
    const dedicated = await realpath(options.testHome).catch(() => null);
    const personal = await realpath(os.homedir());
    if (!dedicated || dedicated === personal) throw new Error("Refusing Antigravity global probe in the personal home; use an existing dedicated test home");
    if (!(await lstat(dedicated)).isDirectory()) throw new Error("--test-home must be a directory");
  }
  const fragment = buildCliHookConfig(client, { nodePath: process.execPath, entryPath: entry });
  const directory = await mkdtemp(path.join(os.tmpdir(), `lore-live-${client}-`));
  const testHome = options.globalProbe ? await realpath(options.testHome) : directory;
  const loreHome = path.join(directory, "data");
  await mkdir(loreHome);
  const config = path.join(loreHome, "lore.json");
  await writeFile(config, JSON.stringify({ enabled: true }));
  const env = { ...process.env, HOME: testHome, LORE_HOME: loreHome, LORE_CONFIG: config, LORE_ENABLED: "true", LORE_REPOSITORY: "lore-live-verification" };
  const report = { schemaVersion: 1, client, version: "unavailable", node: process.version, commit: "unknown", artifacts: directory, checks: {}, limitations: ["Bounded synthetic hooks and recall only; uninstall and every host UI path remain outside this certificate."] };
  try { report.commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim(); } catch { /* evidence remains explicit */ }
  try { const command = { codex: "codex", claude: "claude", antigravity: "agy" }[client]; report.version = (await exec(command, ["--version"], { timeout: 5000 })).stdout.trim().split("\n")[0].slice(0, 120); } catch { /* pending is reported by native recall */ }
  const seed = (name, args) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [entry, "tool", name], { env, cwd: directory }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout));
    child.stdin.end(JSON.stringify(args));
  });
  const hook = (event, payload) => exec(process.execPath, [entry, "hook", client, event], { env, cwd: directory, input: JSON.stringify(payload), maxBuffer: 2 * 1024 * 1024 });
  await seed("lore_onboard", { userName: "Verifier" });
  const word = `quartz-${randomUUID().slice(0, 8)}`;
  await seed("memory_save", { content: `My quartzanchor verification word is ${word}.`, type: "user_preference" });
  const sessions = [];
  for (let index = 0; index < options.sessions; index += 1) {
    const nativeId = `cert-${index}-${randomUUID().slice(0, 6)}`;
    const transcript = path.join(directory, `${nativeId}.jsonl`);
    const messages = client === "codex" ? [
      { type: "response_item", timestamp: "2026-09-06T12:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `quartzanchor session ${index}: remember focused tests.` }] } },
      { type: "response_item", timestamp: "2026-09-06T12:01:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "We decided to run focused tests." }] } },
    ] : client === "claude" ? [
      { uuid: "a", parentUuid: null, type: "user", timestamp: "2026-09-06T12:00:00Z", message: { role: "user", content: `quartzanchor session ${index}: remember focused tests.` } },
      { uuid: "b", parentUuid: "a", type: "assistant", timestamp: "2026-09-06T12:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "We decided to run focused tests." }] } },
    ] : [
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", created_at: "2026-09-06T12:00:00Z", content: `quartzanchor session ${index}: remember focused tests.` },
      { step_index: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: "2026-09-06T12:01:00Z", content: "We decided to run focused tests." },
    ];
    await writeFile(transcript, `${messages.map(JSON.stringify).join("\n")}\n`);
    const payload = client === "antigravity" ? { conversationId: nativeId, workspacePaths: [directory], transcriptPath: transcript, invocationNum: 0, fullyIdle: true } : { session_id: nativeId, cwd: directory, transcript_path: transcript, prompt: "quartzanchor" };
    await hook(client === "antigravity" ? "PreInvocation" : "UserPromptSubmit", payload);
    await hook("Stop", payload);
    await hook("Stop", payload);
    sessions.push(nativeId);
  }
  const db = new DatabaseSync(path.join(loreHome, "lore.db"), { readOnly: true });
  const captured = db.prepare("SELECT session_id, scope, repository, source FROM episode_digest WHERE session_id LIKE ? ORDER BY session_id").all(`${client}:cert-%`);
  const distinctSources = new Set(captured.map((row) => row.source)).size;
  report.checks.capture = captured.length === sessions.length ? status("pass", `${captured.length} sessions captured`) : status("fail", `expected ${sessions.length}, got ${captured.length}`);
  report.checks.duplicateCapture = captured.length === distinctSources ? status("pass", "one digest per session") : status("fail", "duplicate source rows detected");
  report.checks.scopeIsolation = captured.every((row) => row.repository === "lore-live-verification" && row.scope) ? status("pass", "repository and scope recorded") : status("fail", "scope metadata missing");
  db.close();
  for (const [label, input] of [["malformedHook", "{"], ["oversizedHook", "x".repeat(1024 * 1024 + 1)], ["failedHook", JSON.stringify({ session_id: sessions[0], cwd: directory, transcript_path: "/missing" })]]) {
    const result = await new Promise((resolve) => { const child = execFile(process.execPath, [entry, "hook", client, "Stop"], { env, cwd: directory }, (error, stdout, stderr) => resolve({ error, stdout, stderr })); child.stdin.end(input); });
    report.checks[label] = result.stdout.trim() && /^[{][\s\S]*[}]\s*$/u.test(result.stdout.trim()) && !result.stderr.includes(word) ? status("pass") : status("fail", "hook did not return safe neutral output");
  }
  const command = { codex: "codex", claude: "claude", antigravity: "agy" }[client];
  const target = path.join(directory, { codex: ".codex/hooks.json", claude: ".claude/settings.local.json", antigravity: ".gemini/config/hooks.json" }[client]);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(fragment));
  let cleanupProbe = async () => {};
  if (options.globalProbe) {
    const shared = path.join(testHome, ".gemini", "config", "hooks.json");
    const original = await readFile(shared, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const current = original === null ? {} : JSON.parse(original);
    const key = `lore-verification-${randomUUID()}`;
    current[key] = fragment.lore;
    await mkdir(path.dirname(shared), { recursive: true });
    await writeFile(shared, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
    cleanupProbe = async () => { if (original === null) await unlink(shared).catch(() => {}); else await writeFile(shared, original); };
    report.limitations.push("Antigravity global probe uses only the explicitly supplied dedicated test home; credentials are never copied.");
  }
  const prompt = "What is my quartzanchor verification word? Use the memory context already provided to you. Reply with only the word, do not call tools, do not read files, and do not guess if unavailable.";
  const args = { codex: ["exec", "--ignore-user-config", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "-s", "read-only", "-c", `hooks=${toml(fragment.hooks)}`, "--json", prompt], claude: ["--setting-sources", "", "--settings", target, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "", "-p", prompt], antigravity: ["--add-dir", directory, "--mode", "plan", "--output-format", "json", "--print-timeout", "90s", "--print", prompt] }[client];
  try {
    const result = await exec(command, args, { cwd: directory, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(path.join(directory, "stdout.txt"), result.stdout);
    await writeFile(path.join(directory, "stderr.txt"), result.stderr);
    report.checks.nativeRecall = result.stdout.includes(word) ? status("pass", "native client recalled synthetic memory") : status("fail", "native client completed without the verification word");
  } catch (error) {
    await writeFile(path.join(directory, "stdout.txt"), error.stdout ?? "");
    await writeFile(path.join(directory, "stderr.txt"), error.stderr ?? error.message);
    const detail = privateError(error);
    const diagnostic = `${detail} ${String(error.stderr ?? "")}`;
    report.checks.nativeRecall = /401|auth|login|credential|sign.?in|not found|no such file|timed out/iu.test(diagnostic) ? status("pending", "installed client needs an authenticated dedicated profile") : status("fail", detail);
  } finally { await cleanupProbe(); }
  const checks = Object.values(report.checks);
  report.status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "pending") ? "partial" : "pass";
  await writeFile(path.join(directory, "evidence.json"), JSON.stringify(report, null, 2) + "\n");
  if (options.json) console.log(JSON.stringify(report)); else { console.log(`Live ${client} verification artifacts: ${directory}`); console.log(JSON.stringify(report)); }
  if (report.status === "fail") process.exitCode = 1;
}

try { await main(parseArgs(process.argv.slice(2))); }
catch (error) { console.error(`Live verification refused: ${privateError(error)}`); process.exitCode = 2; }
