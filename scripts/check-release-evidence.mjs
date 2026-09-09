import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";
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
  return true;
}

function isValidIsoTimestamp(value) {
  return typeof value === "string"
    && ISO_DATE_TIME.test(value)
    && isValidCalendarDate(value.slice(0, 10))
    && !Number.isNaN(Date.parse(value));
}

function validEvidenceAt(value, path, startTime, endTime, errors) {
  if (!isValidIsoTimestamp(value)) {
    addError(errors, path, "must be a valid UTC ISO timestamp");
    return;
  }
  const time = Date.parse(value);
  if (time < startTime) addError(errors, path, "cannot precede candidate window");
  if (time > endTime) addError(errors, path, "cannot follow certification timestamp");
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

function validateCheck(check, path, candidateCommit, startTime, endTime, errors) {
  if (!checkKeys(check, ["status", "evidence", "at", "commit", "mode", "authenticated"], path, errors)) return;
  if (check.status !== "pass") addError(errors, `${path}.status`, "must be pass");
  validEvidence(check.evidence, `${path}.evidence`, errors);
  validEvidenceAt(check.at, `${path}.at`, startTime, endTime, errors);
  if (check.commit !== candidateCommit) addError(errors, `${path}.commit`, "does not match candidateCommit");
  if (check.mode !== "real") addError(errors, `${path}.mode`, "must be real");
  if (check.authenticated !== true) addError(errors, `${path}.authenticated`, "must be true");
}

function validateClient(client, clientName, candidateCommit, candidateTag, startTime, endTime, nowDate, errors) {
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

  if (checkKeys(client.installation, ["tagged", "tag", "commit", "evidence", "at"], `${path}.installation`, errors)) {
    if (client.installation.tagged !== true) addError(errors, `${path}.installation.tagged`, "must be true");
    if (client.installation.tag !== candidateTag) addError(errors, `${path}.installation.tag`, "does not match candidateTag");
    if (client.installation.commit !== candidateCommit) addError(errors, `${path}.installation.commit`, "does not match candidateCommit");
    validEvidence(client.installation.evidence, `${path}.installation.evidence`, errors);
    validEvidenceAt(client.installation.at, `${path}.installation.at`, startTime, endTime, errors);
  }

  if (checkKeys(client.checks, REQUIRED_CHECKS, `${path}.checks`, errors)) {
    for (const checkName of REQUIRED_CHECKS) {
      if (!(checkName in client.checks)) addError(errors, `${path}.checks.${checkName}`, "is required");
      else validateCheck(client.checks[checkName], `${path}.checks.${checkName}`, candidateCommit, startTime, endTime, errors);
    }
  }

  if (!Array.isArray(client.soak)) {
    addError(errors, `${path}.soak`, "must be an array");
    return;
  }
  const days = new Set();
  for (const [index, entry] of client.soak.entries()) {
    const entryPath = `${path}.soak[${index}]`;
    if (!checkKeys(entry, ["date", "at", "commit", "success", "evidence"], entryPath, errors)) continue;
    if (!isValidCalendarDate(entry.date)) {
      addError(errors, `${entryPath}.date`, "must be a valid YYYY-MM-DD date");
    } else {
      if (entry.date > nowDate) addError(errors, `${entryPath}.date`, "cannot be in the future");
      if (days.has(entry.date)) addError(errors, `${entryPath}.date`, "duplicate day cannot inflate the count");
      days.add(entry.date);
    }
    validEvidenceAt(entry.at, `${entryPath}.at`, startTime, endTime, errors);
    if (typeof entry.at === "string" && ISO_DATE_TIME.test(entry.at) && entry.date !== entry.at.slice(0, 10)) {
      addError(errors, `${entryPath}.date`, "must match at UTC date");
    }
    if (entry.commit !== candidateCommit) addError(errors, `${entryPath}.commit`, "does not match candidateCommit");
    if (entry.success !== true) addError(errors, `${entryPath}.success`, "must be true");
    validEvidence(entry.evidence, `${entryPath}.evidence`, errors);
  }
  const successfulDays = client.soak.filter((entry) => entry?.success === true && typeof entry.date === "string" && DATE.test(entry.date));
  const distinctSuccessfulDays = new Set(successfulDays.map((entry) => entry.date));
  if (distinctSuccessfulDays.size < 10) addError(errors, `${path}.soak`, "requires at least 10 distinct successful days");
}

export function validateReleaseEvidence(input, { now = new Date() } = {}) {
  const errors = [];
  const nowDate = now.toISOString().slice(0, 10);
  const certificationErrors = [];
  const soakErrors = [];
  if (!checkKeys(input, ["schemaVersion", "candidateCommit", "candidateTag", "startedAt", "generatedAt", "clients"], "evidence", errors)) {
    return { ok: false, certification: { ok: false, blockers: errors }, soak: { ok: false, blockers: errors }, blockers: errors, reviewedAttestationOnly: true };
  }
  if (input.schemaVersion !== RELEASE_EVIDENCE_SCHEMA_VERSION) addError(errors, "evidence.schemaVersion", "unsupported schema version");
  if (typeof input.candidateCommit !== "string" || !HEX_COMMIT.test(input.candidateCommit)) addError(errors, "evidence.candidateCommit", "must be a 40-character lowercase commit hash");
  if (typeof input.candidateTag !== "string" || input.candidateTag.trim() === "") addError(errors, "evidence.candidateTag", "is required");
  if (!isValidIsoTimestamp(input.startedAt)) addError(errors, "evidence.startedAt", "must be a valid UTC ISO timestamp");
  if (!isValidIsoTimestamp(input.generatedAt)) addError(errors, "evidence.generatedAt", "must be a valid UTC ISO timestamp");
  else if (Date.parse(input.generatedAt) > now.getTime()) addError(errors, "evidence.generatedAt", "cannot be in the future");

  const startTime = Date.parse(input.startedAt);
  const endTime = Date.parse(input.generatedAt);
  if (!Number.isNaN(startTime) && !Number.isNaN(endTime)) {
    if (endTime <= startTime) addError(errors, "evidence.generatedAt", "must follow startedAt");
    if (endTime - startTime < 14 * 86_400_000) addError(soakErrors, "evidence", "candidate window must span at least 14 elapsed calendar days");
  }

  const clients = isObject(input.clients) ? input.clients : {};
  for (const key of Object.keys(clients)) if (!REQUIRED_CLIENTS.includes(key)) addError(errors, `evidence.clients.${key}`, "unknown client");
  for (const clientName of REQUIRED_CLIENTS) {
    if (!(clientName in clients)) addError(errors, `evidence.clients.${clientName}`, "all five actual clients are required");
    else {
      const clientErrors = [];
      validateClient(clients[clientName], clientName, input.candidateCommit, input.candidateTag, startTime, endTime, nowDate, clientErrors);
      for (const error of clientErrors) {
        const field = error.slice(0, error.indexOf(":"));
        if (field.startsWith(`clients.${clientName}.soak`)) soakErrors.push(error);
        else if (field.startsWith(`clients.${clientName}.checks`) || field.startsWith(`clients.${clientName}.installation`)) certificationErrors.push(error);
        else errors.push(error); // Missing client structure or execution metadata invalidates both gates.
      }
    }
  }

  const certificationBlockers = [...errors, ...certificationErrors];
  const soakBlockers = [...errors, ...soakErrors];
  const blockers = [...errors, ...certificationErrors, ...soakErrors];
  return {
    ok: blockers.length === 0,
    certification: { ok: certificationBlockers.length === 0, blockers: certificationBlockers },
    soak: { ok: soakBlockers.length === 0, blockers: soakBlockers },
    blockers,
    reviewedAttestationOnly: true,
  };
}

export function evidenceReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const item of value) evidenceReferences(item, references);
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "evidence" && typeof child === "string") references.push(child);
      else evidenceReferences(child, references);
    }
  }
  return references;
}

async function checkLocalEvidenceFiles(input, ledgerPath) {
  const blockers = [];
  const references = [...new Set(evidenceReferences(input))];
  const ledgerRealPath = await realpath(ledgerPath).catch(() => resolve(ledgerPath));
  const ledgerRoot = dirname(ledgerRealPath);
  for (const reference of references) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) {
      blockers.push(`evidence ${reference}: must be a local ledger reference`);
      continue;
    }
    const target = resolve(ledgerRoot, reference);
    try {
      await access(target, constants.R_OK);
      const targetRealPath = await realpath(target);
      if (targetRealPath !== ledgerRoot && !targetRealPath.startsWith(`${ledgerRoot}/`)) {
        blockers.push(`evidence ${reference}: must remain within the ledger directory`);
        continue;
      }
      const details = await stat(targetRealPath);
      if (!details.isFile() || details.size === 0) blockers.push(`evidence ${reference}: must reference a non-empty regular file`);
    } catch {
      blockers.push(`evidence ${reference}: referenced file does not exist or is not readable`);
    }
  }
  return { references, blockers };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  if (args.length !== 1 || file === "--help") {
    console.error("Usage: node scripts/check-release-evidence.mjs <evidence.json>");
    process.exitCode = args.length === 1 && file === "--help" ? 0 : 2;
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
  const artifacts = await checkLocalEvidenceFiles(input, file);
  const output = { ...result, ok: result.ok && artifacts.blockers.length === 0, artifactReferences: artifacts.references.length, artifactBlockers: artifacts.blockers };
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
}

let invokedAsCli = false;
try {
  invokedAsCli = Boolean(process.argv[1]) && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1]);
} catch {
  invokedAsCli = false;
}
if (invokedAsCli) await main();
