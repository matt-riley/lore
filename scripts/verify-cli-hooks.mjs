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
    else if (arg === "--test-home") {
      if (!rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error("--test-home requires a directory");
      options.testHome = path.resolve(rest[++i]);
    }
    else if (arg === "--sessions") {
      if (!/^\d+$/.test(rest[i + 1] ?? "")) throw new Error("--sessions requires an integer");
      options.sessions = Math.min(4, Math.max(1, Number(rest[++i])));
    }
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!["codex", "claude", "antigravity"].includes(client)) throw new Error("Client must be codex, claude, or antigravity");
  if (options.globalProbe && client !== "antigravity") throw new Error("--global-hook-probe is only valid for Antigravity");
  return { client, options };
}

const entry = fileURLToPath(new URL("../lore-cli.mjs", import.meta.url));
const repoRoot = path.dirname(entry);
const privateError = (error) => String(error?.message ?? error).replaceAll(/\s+/gu, " ").slice(0, 240);
const status = (state, detail = undefined) => ({ status: state, ...(detail ? { detail } : {}) });
const toml = (value) => Array.isArray(value) ? `[${value.map(toml).join(", ")}]`
  : value !== null && typeof value === "object" ? `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(", ")} }` : JSON.stringify(value);

function hasFinalAnswer(stdout, client, expected) {
  const wanted = String(expected).trim();
  if (client === "claude" && stdout.trim() === wanted) return true;
  for (const line of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      const visit = (node) => {
        if (!node || typeof node !== "object") return false;
        if (node.role === "assistant" || node.type === "output_text" || node.type === "assistant") {
          const text = typeof node.text === "string" ? node.text : typeof node.content === "string" ? node.content : null;
          if (text?.trim() === wanted) return true;
        }
        return Object.values(node).some((child) => Array.isArray(child) ? child.some(visit) : visit(child));
      };
      if (visit(value)) return true;
    } catch {
      // Native clients may emit non-JSON diagnostics alongside their final answer.
    }
  }
  return false;
}

async function main({ client, options }) {
  if (options.globalProbe) {
    if (!options.testHome) throw new Error("Antigravity global probe requires --test-home <dedicated-directory>");
    const dedicated = await realpath(options.testHome).catch(() => null);
    const personal = await realpath(os.homedir());
    const personalConfig = await realpath(path.join(personal, ".gemini")).catch(() => path.join(personal, ".gemini"));
    const under = (parent, candidate) => {
      const relative = path.relative(parent, candidate);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };
    if (!dedicated || under(personal, dedicated) || under(personalConfig, dedicated)) throw new Error("Refusing Antigravity global probe in the personal home/config; use an existing dedicated test home");
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
  const report = { schemaVersion: 1, client, version: "unavailable", node: process.version, commit: "unknown", captureMode: "simulated", artifacts: directory, checks: {}, limitations: ["Captured transcripts are simulated; uninstall and every host UI path remain outside this certificate."] };
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
  const distinctSessions = new Set(captured.map((row) => row.session_id)).size;
  report.checks.capture = captured.length === sessions.length ? status("pass", `${captured.length} sessions captured`) : status("fail", `expected ${sessions.length}, got ${captured.length}`);
  report.checks.duplicateCapture = captured.length === distinctSessions ? status("pass", "one digest per captured session id") : status("fail", "duplicate session ids detected");
  const globalMarker = `global-${randomUUID().slice(0, 8)}`;
  const otherRepoMarker = `other-repo-${randomUUID().slice(0, 8)}`;
  await seed("memory_save", { content: globalMarker, type: "user_preference", scope: "global" });
  await seed("memory_save", { content: otherRepoMarker, type: "user_preference", repository: "other-certification-repository", scope: "repo" });
  const localSearch = await seed("memory_search", { query: otherRepoMarker, includeOtherRepositories: false });
  const crossGlobalSearch = await seed("memory_search", { query: globalMarker, includeOtherRepositories: true });
  const crossRepoSearch = await seed("memory_search", { query: otherRepoMarker, includeOtherRepositories: true });
  const localText = localSearch.join ? localSearch.join("") : String(localSearch);
  const crossGlobalText = crossGlobalSearch.join ? crossGlobalSearch.join("") : String(crossGlobalSearch);
  const crossRepoText = crossRepoSearch.join ? crossRepoSearch.join("") : String(crossRepoSearch);
  report.checks.scopeIsolation = crossGlobalText.includes(globalMarker) && crossRepoText.includes(otherRepoMarker) && !localText.includes(otherRepoMarker)
    ? status("pass", "global and other-repository memories follow retrieval scope")
    : status("fail", "cross-repository retrieval did not match the requested scope");
  db.close();
  for (const [label, input] of [["malformedHook", "{"], ["oversizedHook", "x".repeat(1024 * 1024 + 1)], ["failedHook", JSON.stringify({ session_id: sessions[0], cwd: directory, transcript_path: "/missing" })]]) {
    const result = await new Promise((resolve) => { const child = execFile(process.execPath, [entry, "hook", client, "Stop"], { env, cwd: directory }, (error, stdout, stderr) => resolve({ error, stdout, stderr })); child.stdin.end(input); });
    let parsed;
    try { parsed = JSON.parse(result.stdout.trim()); } catch { parsed = null; }
    const expectedNeutral = client === "antigravity" && label === "failedHook" ? { decision: "stop" } : client === "antigravity" ? { decision: "stop" } : {};
    report.checks[label] = parsed && JSON.stringify(parsed) === JSON.stringify(expectedNeutral) && !result.stderr.includes(word) ? status("pass") : status("fail", "hook did not return the exact safe neutral output");
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
    cleanupProbe = async () => {
      let current = {};
      try { current = JSON.parse(await readFile(shared, "utf8")); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (JSON.stringify(current[key]) !== JSON.stringify(fragment.lore)) return;
      delete current[key];
      if (original === null && Object.keys(current).length === 0) await unlink(shared).catch(() => {});
      else await writeFile(shared, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
    };
    process.once("SIGINT", async () => { await cleanupProbe(); process.exit(130); });
    process.once("SIGTERM", async () => { await cleanupProbe(); process.exit(143); });
    report.limitations.push("Antigravity global probe uses only the explicitly supplied dedicated test home; credentials are never copied.");
  }
  const prompt = "What is my quartzanchor verification word? Use the memory context already provided to you. Reply with only the word, do not call tools, do not read files, and do not guess if unavailable.";
  const args = { codex: ["exec", "--ignore-user-config", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "-s", "read-only", "-c", `hooks=${toml(fragment.hooks)}`, "--json", prompt], claude: ["--setting-sources", "", "--settings", target, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "", "-p", prompt], antigravity: ["--add-dir", directory, "--mode", "plan", "--output-format", "json", "--print-timeout", "90s", "--print", prompt] }[client];
  try {
    const result = await exec(command, args, { cwd: directory, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(path.join(directory, "stdout.txt"), result.stdout, { mode: 0o600 });
    await writeFile(path.join(directory, "stderr.txt"), result.stderr, { mode: 0o600 });
    report.checks.nativeRecall = hasFinalAnswer(result.stdout, client, word) ? status("pass", "native client returned the exact recalled word as its final answer") : status("fail", "native client completed without returning the exact verification word as its final answer");
  } catch (error) {
    await writeFile(path.join(directory, "stdout.txt"), error.stdout ?? "", { mode: 0o600 });
    await writeFile(path.join(directory, "stderr.txt"), error.stderr ?? error.message, { mode: 0o600 });
    const detail = privateError(error);
    const diagnostic = `${detail} ${String(error.stdout ?? "")} ${String(error.stderr ?? "")}`;
    report.checks.nativeRecall = /401|auth|logged\s+in|not\s+logged\s+in|login|\/login|credential|sign.?in|unauthenticated/iu.test(diagnostic) ? status("pending", "installed client needs an authenticated dedicated profile") : /ENOENT|spawn/iu.test(diagnostic) ? status("pending", "client executable is unavailable") : status("fail", detail);
  } finally { await cleanupProbe(); }
  const checks = Object.values(report.checks);
  report.status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "pending") ? "partial" : "pass";
  await writeFile(path.join(directory, "evidence.json"), JSON.stringify(report, null, 2) + "\n");
  if (options.json) console.log(JSON.stringify(report)); else { console.log(`Live ${client} verification artifacts: ${directory}`); console.log(JSON.stringify(report)); }
  if (report.status === "fail") process.exitCode = 1;
}

try { await main(parseArgs(process.argv.slice(2))); }
catch (error) { console.error(`Live verification refused: ${privateError(error)}`); process.exitCode = 2; }
