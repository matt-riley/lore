#!/usr/bin/env node

/**
 * Bounded Copilot/Pi adapter lifecycle evidence.
 *
 * Mock mode is deterministic and never reads or writes a user's client home.
 * Live mode is deliberately opt-in (--live-host); it uses a synthetic home and
 * reports pending when a client cannot be safely isolated.  A result is only a
 * certification input when its evidence label says "mocked" or "live".
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { mode: "mock", output: null, liveHost: false, timeoutMs: 120_000, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--mock") args.mode = "mock";
    else if (arg === "--live-host") { args.mode = "live"; args.liveHost = true; }
    else if (arg === "--all") args.mode = "all";
    else if (arg === "--output") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--output requires a file path");
      args.output = argv[++i];
    }
    else if (arg === "--timeout-ms") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--") || !/^\d+$/u.test(value)) throw new Error("--timeout-ms requires an integer");
      args.timeoutMs = Math.min(120_000, Math.max(1_000, Number(value)));
      i += 1;
    }
    else throw new Error(`unknown option: ${arg}`);
  }
  return args;
}

function help() {
  return [
    "Usage: node scripts/verify-extension-clients.mjs [--mock|--live-host|--all] [--output FILE]",
    "",
    "--mock       Run deterministic fixture-backed checks (default); no client home is touched.",
    "--live-host  Opt in to bounded host checks using a synthetic home; unsafe/unavailable checks stay pending.",
    "--all        Run mock checks and then the opt-in live checks (equivalent to --live-host after mock).",
    "--output     Write the redacted evidence JSON to FILE (otherwise stdout only).",
    "--timeout-ms Bound a live child process, capped at 120000ms.",
  ].join("\n");
}

function result(id, outcome, evidence, detail = "") {
  return { id, outcome, evidence, detail };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    env: { ...process.env, ...options.env },
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function runTest(testFile, extraArgs = [], timeout = 30_000) {
  try {
    run(process.execPath, ["--test", ...extraArgs, testFile], { timeout });
    return true;
  } catch {
    return false;
  }
}

function nodeVersion(node = process.execPath) {
  try { return run(node, ["--version"]); } catch { return "unavailable"; }
}

function commit() {
  try { return run("git", ["rev-parse", "HEAD"]); } catch { return "unknown"; }
}

function runMock() {
  const outcomes = [];
  const piLifecycle = runTest(path.join(root, "tests", "smoke", "pi-adapter-lifecycle.test.mjs"), ["--experimental-strip-types"], 30_000);
  outcomes.push(result("pi.worker-restart", piLifecycle ? "passed" : "failed", "mocked", "executed the Pi adapter lifecycle smoke test: concurrent init and recovery after worker exit"));
  const piTransport = runTest(path.join(root, "tests", "smoke", "pi-server-client.test.mjs"));
  outcomes.push(result("pi.worker-exit-malformed-transport", piTransport ? "passed" : "failed", "mocked", "executed Pi server-client tests covering startup failure, pending-request rejection, fragmented JSON, and fresh-child restart"));
  const copilotShutdown = runTest(path.join(root, "tests", "unit", "extension-shutdown.test.mjs"));
  outcomes.push(result("copilot.shutdown-lifecycle", copilotShutdown ? "passed" : "failed", "mocked", "executed extension shutdown unit tests covering tracked work drain, bounded shutdown, and idempotence"));
  const paths = runTest(path.join(root, "tests", "unit", "lore-paths.test.mjs"));
  outcomes.push(result("scope.path-isolation", paths ? "passed" : "failed", "mocked", "executed path-resolution tests for explicit Lore and Copilot homes"));
  const worker = runWorkerSaveRestartRecall();
  outcomes.push(result("worker.save-restart-recall", worker.ok ? "passed" : "failed", "mocked", worker.detail));
  outcomes.push(result("copilot.capture-new-session", "pending", "mocked", "no existing behavioral test proves automatic capture and new-session recall"));
  outcomes.push(result("repo-isolation-global", "pending", "mocked", "no existing adapter-level behavioral test proves both repository and global recall"));
  outcomes.push(result("install-runtime-loading", "pending", "mocked", "runtime loading requires the client host; source presence is not evidence"));
  return outcomes;
}

function workerRequest(home, requests) {
  const config = path.join(home, "lore.json");
  const input = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;
  try {
    const stdout = run(process.execPath, [path.join(root, "lore-server.mjs")], {
      timeout: 30_000,
      env: { LORE_HOME: home, LORE_CONFIG: config },
      input,
    });
    return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    return [{ ok: false, error: String(error?.stderr || error?.message || error) }];
  }
}

function runWorkerSaveRestartRecall() {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-worker-cert-"));
  try {
    writeFileSync(path.join(home, "lore.json"), JSON.stringify({ enabled: true }));
    const marker = `worker-${Date.now()}`;
    const first = workerRequest(home, [
      { id: 1, method: "save", params: { content: `The ${marker} memory survives a worker restart.`, type: "user_preference", repository: "certification" } },
    ]);
    const second = workerRequest(home, [
      { id: 2, method: "recall", params: { prompt: marker, retrievalPrompt: marker, repository: "certification" } },
    ]);
    const saved = first.find((response) => response.id === 1)?.ok === true;
    const recalled = second.find((response) => response.id === 2)?.result?.text;
    const ok = saved && typeof recalled === "string" && recalled.includes(marker);
    return { ok, detail: ok ? "real lore-server JSON-lines save, process restart, and recall succeeded" : "real lore-server JSON-lines save/restart/recall did not return the marker" };
  } finally {
    // The worker owns only this synthetic home; leave it available as evidence for failures.
  }
}

function livePending(reason) {
  return [
    result("copilot.save-restart-recall", "pending", "live", reason),
    result("copilot.capture-new-session", "pending", "live", reason),
    result("scope.repo-isolation-global", "pending", "live", reason),
    result("duplicate-reload", "pending", "live", reason),
    result("pi.save-restart-recall", "pending", "live", reason),
    result("pi.malformed-payload", "pending", "live", reason),
    result("worker-exit-recovery", "pending", "live", reason),
    result("pi.install-runtime-loading", "pending", "live", reason),
    result("copilot.install-runtime-loading", "pending", "live", reason),
  ];
}

function runLive(timeoutMs) {
  const syntheticHome = mkdtempSync(path.join(os.tmpdir(), "lore-extension-cert-"));
  {
    const node24 = process.env.LORE_NODE || process.execPath;
    const piVersion = (() => { try { return run("pi", ["--version"], { timeout: 10_000 }); } catch { return "unavailable"; } })();
    const copilotVersion = (() => { try { return run("copilot", ["--version"], { timeout: 10_000 }); } catch { return "unavailable"; } })();
    const config = path.join(syntheticHome, "lore.json");
    writeFileSync(config, JSON.stringify({ enabled: true }));
    const livePi = piVersion === "unavailable" || !runNodeExists(node24)
      ? { ok: false, detail: piVersion === "unavailable" ? "Pi executable unavailable" : "Node 24 runtime unavailable" }
      : runPiBounded(syntheticHome, config, node24, timeoutMs);
    const outcomes = livePending("live host scenario not exercised");
    const piStartup = outcomes.find((item) => item.id === "pi.install-runtime-loading");
    if (piStartup) {
      piStartup.outcome = livePi.ok ? "passed" : "pending";
      piStartup.detail = livePi.ok
        ? "Pi launched with -ne -e lore-pi.ts, synthetic --session-dir, no context files, no skills, and no builtin tools"
        : livePi.detail;
    }
    outcomes.find((item) => item.id === "copilot.install-runtime-loading").detail = copilotVersion === "unavailable"
      ? "Copilot executable unavailable"
      : "Copilot help exposes no isolated extension-directory/config-dir contract; pending to avoid touching the real Copilot home";
    return { outcomes, versions: { copilot: copilotVersion, pi: piVersion, node: runNodeExists(node24) ? nodeVersion(node24) : "unavailable" }, artifacts: syntheticHome };
  }
}

function runNodeExists(node) {
  try { run(node, ["--version"], { timeout: 5_000 }); return true; } catch { return false; }
}

function runPiBounded(home, config, node24, timeoutMs) {
  try {
    const output = run("pi", ["-ne", "-e", path.join(root, "lore-pi.ts"), "--session-dir", path.join(home, "sessions"), "--no-context-files", "--no-skills", "--no-builtin-tools", "-p", "Reply with exactly READY"], {
      timeout: Math.min(timeoutMs, 120_000),
      env: { LORE_HOME: home, LORE_CONFIG: config, LORE_NODE: node24, PI_CODING_AGENT_DIR: path.join(home, "pi-agent") },
    });
    return /(?:^|\n)READY(?:\n|$)/u.test(output.trim()) ? { ok: true, detail: "Pi launched and returned the requested READY answer" } : { ok: false, detail: "Pi exited successfully without the requested READY answer" };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "Pi launch failed").trim().split("\n").slice(-3).join(" ");
    return { ok: false, detail: `Pi bounded launch failed: ${detail.slice(0, 500)}` };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(help()); return; }
  const mockOutcomes = args.mode === "live" ? [] : runMock();
  const live = args.mode === "live" || args.mode === "all" ? runLive(args.timeoutMs) : { outcomes: [] };
  const outcomes = [...mockOutcomes, ...live.outcomes];
  const evidence = {
    schema: "lore.extension-client-certification.v1",
    generatedAt: new Date().toISOString(),
    commit: commit(),
    node: nodeVersion(),
    clientVersions: live.versions ?? {},
    mode: args.mode,
    synthetic: args.mode !== "live" && args.mode !== "all",
    artifacts: live.artifacts,
    outcomes,
    summary: {
      passed: outcomes.filter((item) => item.outcome === "passed").length,
      pending: outcomes.filter((item) => item.outcome === "pending").length,
      failed: outcomes.filter((item) => item.outcome === "failed").length,
    },
  };
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (args.output) writeFileSync(path.resolve(args.output), text);
  process.stdout.write(text);
  if (evidence.summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`verify-extension-clients: ${error.message}`);
  process.exitCode = 2;
});
