import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const RELEASE_EVIDENCE_SCHEMA_VERSION = 1;
export const REQUIRED_CLIENTS = ["copilot", "pi", "codex", "claude", "antigravity"];
export const REQUIRED_CHECKS = [
  "taggedInstallation",
  "explicitSaveRecall",
  "automaticCaptureFreshSessionRecall",
  "scopeIsolation",
  "reload",
  "failureHandling",
  "update",
  "removal",
  "recovery",
];

const HEX_COMMIT = /^[0-9a-f]{40}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const FORBIDDEN_EVIDENCE = /mock|simulat(?:e|ed|ion)|fixture|synthetic|partial|pending|unperformed|fake|placeholder/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addError(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function checkKeys(value, allowed, path, errors) {
  if (!isObject(value)) {
    addError(errors, path, "must be an object");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) addError(errors, `${path}.${key}`, "unknown field");
  }
  return true;
}

function validEvidence(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    addError(errors, path, "requires a non-empty evidence reference");
    return false;
  }
  if (FORBIDDEN_EVIDENCE.test(value)) addError(errors, path, "must reference actual, completed evidence");
  return true;
}

function parseNodeMajor(value) {
  const match = typeof value === "string" && value.match(/^v?(\d+)(?:\.\d+){1,2}$/u);
  return match ? Number(match[1]) : null;
}

function isValidCalendarDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateCheck(check, path, candidateCommit, errors) {
  if (!checkKeys(check, ["status", "evidence", "commit", "mode", "authenticated"], path, errors)) return;
  if (check.status !== "pass") addError(errors, `${path}.status`, "must be pass");
  validEvidence(check.evidence, `${path}.evidence`, errors);
  if (check.commit !== candidateCommit) addError(errors, `${path}.commit`, "does not match candidateCommit");
  if (check.mode !== "real") addError(errors, `${path}.mode`, "must be real");
  if (check.authenticated !== true) addError(errors, `${path}.authenticated`, "must be true");
}

function validateClient(client, clientName, candidateCommit, candidateTag, nowDate, errors) {
  const path = `clients.${clientName}`;
  if (!checkKeys(client, ["platform", "nodeVersion", "clientVersion", "execution", "installation", "checks", "soak"], path, errors)) return;
  if (client.platform !== "macos") addError(errors, `${path}.platform`, "must be macos");
  const nodeMajor = parseNodeMajor(client.nodeVersion);
  if (nodeMajor === null || nodeMajor < 24) addError(errors, `${path}.nodeVersion`, "must be a valid Node version >=24");
  if (typeof client.clientVersion !== "string" || client.clientVersion.trim() === "") addError(errors, `${path}.clientVersion`, "is required");

  if (checkKeys(client.execution, ["mode", "authenticated"], `${path}.execution`, errors)) {
    if (client.execution.mode !== "real") addError(errors, `${path}.execution.mode`, "must be real");
    if (client.execution.authenticated !== true) addError(errors, `${path}.execution.authenticated`, "must be true");
  }

  if (checkKeys(client.installation, ["tagged", "tag", "commit", "evidence"], `${path}.installation`, errors)) {
    if (client.installation.tagged !== true) addError(errors, `${path}.installation.tagged`, "must be true");
    if (client.installation.tag !== candidateTag) addError(errors, `${path}.installation.tag`, "does not match candidateTag");
    if (client.installation.commit !== candidateCommit) addError(errors, `${path}.installation.commit`, "does not match candidateCommit");
    validEvidence(client.installation.evidence, `${path}.installation.evidence`, errors);
  }

  if (checkKeys(client.checks, REQUIRED_CHECKS, `${path}.checks`, errors)) {
    for (const checkName of REQUIRED_CHECKS) {
      if (!(checkName in client.checks)) addError(errors, `${path}.checks.${checkName}`, "is required");
      else validateCheck(client.checks[checkName], `${path}.checks.${checkName}`, candidateCommit, errors);
    }
  }

  if (!Array.isArray(client.soak)) {
    addError(errors, `${path}.soak`, "must be an array");
    return;
  }
  const days = new Set();
  for (const [index, entry] of client.soak.entries()) {
    const entryPath = `${path}.soak[${index}]`;
    if (!checkKeys(entry, ["date", "commit", "success", "evidence"], entryPath, errors)) continue;
    if (!isValidCalendarDate(entry.date)) {
      addError(errors, `${entryPath}.date`, "must be a valid YYYY-MM-DD date");
    } else {
      if (entry.date > nowDate) addError(errors, `${entryPath}.date`, "cannot be in the future");
      if (days.has(entry.date)) addError(errors, `${entryPath}.date`, "duplicate day cannot inflate the count");
      days.add(entry.date);
    }
    if (entry.commit !== candidateCommit) addError(errors, `${entryPath}.commit`, "does not match candidateCommit");
    if (entry.success !== true) addError(errors, `${entryPath}.success`, "must be true");
    validEvidence(entry.evidence, `${entryPath}.evidence`, errors);
  }
  const successfulDays = client.soak.filter((entry) => entry?.success === true && typeof entry.date === "string" && DATE.test(entry.date));
  const distinctSuccessfulDays = new Set(successfulDays.map((entry) => entry.date));
  if (distinctSuccessfulDays.size < 10) addError(errors, `${path}.soak`, "requires at least 10 distinct successful days");
  if (distinctSuccessfulDays.size > 0) {
    const sorted = [...distinctSuccessfulDays].sort();
    const elapsedDays = (Date.parse(`${sorted.at(-1)}T00:00:00Z`) - Date.parse(`${sorted[0]}T00:00:00Z`)) / 86_400_000;
    if (elapsedDays < 13) addError(errors, `${path}.soak`, "must span at least 14 elapsed calendar days");
  }
}

export function validateReleaseEvidence(input, { now = new Date() } = {}) {
  const errors = [];
  const nowDate = now.toISOString().slice(0, 10);
  if (!checkKeys(input, ["schemaVersion", "candidateCommit", "candidateTag", "generatedAt", "clients"], "evidence", errors)) {
    return { ok: false, certification: { ok: false, blockers: errors }, soak: { ok: false, blockers: errors }, blockers: errors };
  }
  if (input.schemaVersion !== RELEASE_EVIDENCE_SCHEMA_VERSION) addError(errors, "evidence.schemaVersion", "unsupported schema version");
  if (typeof input.candidateCommit !== "string" || !HEX_COMMIT.test(input.candidateCommit)) addError(errors, "evidence.candidateCommit", "must be a 40-character lowercase commit hash");
  if (typeof input.candidateTag !== "string" || input.candidateTag.trim() === "") addError(errors, "evidence.candidateTag", "is required");
  if (typeof input.generatedAt !== "string" || !ISO_DATE_TIME.test(input.generatedAt) || Number.isNaN(Date.parse(input.generatedAt))) addError(errors, "evidence.generatedAt", "must be a valid UTC ISO timestamp");
  else if (Date.parse(input.generatedAt) > now.getTime()) addError(errors, "evidence.generatedAt", "cannot be in the future");

  const clients = isObject(input.clients) ? input.clients : {};
  for (const key of Object.keys(clients)) if (!REQUIRED_CLIENTS.includes(key)) addError(errors, `evidence.clients.${key}`, "unknown client");
  for (const clientName of REQUIRED_CLIENTS) {
    if (!(clientName in clients)) addError(errors, `evidence.clients.${clientName}`, "all five actual clients are required");
    else validateClient(clients[clientName], clientName, input.candidateCommit, input.candidateTag, nowDate, errors);
  }

  const certificationBlockers = errors.filter((error) => !error.includes(".soak"));
  const soakBlockers = errors.filter((error) => error.includes(".soak") || error.includes("generatedAt"));
  return {
    ok: errors.length === 0,
    certification: { ok: certificationBlockers.length === 0, blockers: certificationBlockers },
    soak: { ok: soakBlockers.length === 0, blockers: soakBlockers },
    blockers: errors,
  };
}

async function main() {
  const file = process.argv[2];
  if (!file || file === "--help") {
    console.error("Usage: node scripts/check-release-evidence.mjs <evidence.json>");
    process.exitCode = file === "--help" ? 0 : 2;
    return;
  }
  let input;
  try {
    input = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, blockers: [`input: ${error.message}`] }, null, 2));
    process.exitCode = 2;
    return;
  }
  const result = validateReleaseEvidence(input);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
