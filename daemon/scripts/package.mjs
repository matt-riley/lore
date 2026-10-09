#!/usr/bin/env node
// Package the v2 daemon and CLI into a versioned archive with checksums, a
// file manifest and an SBOM. Build tooling only: this script never ships to
// hosts and never runs in the runtime path.
//
// Usage:
//   node scripts/package.mjs [--dist DIR] [--skip-build] [--binary-dir DIR]
//                            [--target TRIPLE] [--repo-root DIR]
//                            [--sign] [--notarize]
//   node scripts/package.mjs --verify dist/lore-<version>-<target>.tar.gz
//
// Signing and notarization are opt-in and fail loudly when requested without
// credentials; an unsigned build is never reported as signed.
//   --sign       codesign the macOS binaries (LORE_CODESIGN_IDENTITY)
//   --notarize   notarize the macOS zip and wait for the verdict
//                (LORE_NOTARY_KEY/LORE_NOTARY_KEY_ID/LORE_NOTARY_ISSUER or
//                 LORE_NOTARY_APPLE_ID/LORE_NOTARY_PASSWORD/LORE_NOTARY_TEAM_ID)

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const options = {
    dist: null,
    skipBuild: false,
    binaryDir: null,
    target: null,
    repoRoot: REPO_ROOT,
    verify: null,
    sign: false,
    notarize: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dist") options.dist = argv[++index];
    else if (value === "--skip-build") options.skipBuild = true;
    else if (value === "--binary-dir") options.binaryDir = argv[++index];
    else if (value === "--target") options.target = argv[++index];
    else if (value === "--repo-root") options.repoRoot = path.resolve(argv[++index]);
    else if (value === "--verify") options.verify = argv[++index];
    else if (value === "--sign") options.sign = true;
    else if (value === "--notarize") options.notarize = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(command, args, { capture = false } = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

/// Codesign the staged macOS binaries with the hardened runtime and a secure
/// timestamp, then verify the signature that was just applied.
function codesignStage(stage, target) {
  if (!target.includes("darwin")) {
    throw new Error("signing applies to macOS targets only");
  }
  const identity = requireEnv("LORE_CODESIGN_IDENTITY");
  if (process.platform !== "darwin") {
    throw new Error(
      `codesign is required to sign macOS artifacts; this host is ${process.platform}`,
    );
  }
  for (const binary of ["lore", "lored"]) {
    const file = path.join(stage, "bin", binary);
    run("codesign", [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      identity,
      file,
    ]);
    run("codesign", ["--verify", "--strict", "--verbose=2", file]);
  }
  return identity;
}

/// Zip the signed stage and submit it to Apple's notary service. The zip
/// itself cannot be stapled, so the notarization ticket is reported for the
/// release notes and Gatekeeper validates it online on first run.
function notarizeStage(stage, dist, version, target) {
  if (!target.includes("darwin")) {
    throw new Error("notarization applies to macOS targets only");
  }
  const zip = path.join(dist, `lore-${version}-${target}.zip`);
  rmSync(zip, { force: true });
  run("ditto", ["-c", "-k", "--keepParent", stage, zip]);
  const args = ["notarytool", "submit", zip, "--wait"];
  if (process.env.LORE_NOTARY_KEY) {
    args.push(
      "--key",
      process.env.LORE_NOTARY_KEY,
      "--key-id",
      requireEnv("LORE_NOTARY_KEY_ID"),
      "--issuer",
      requireEnv("LORE_NOTARY_ISSUER"),
    );
  } else if (process.env.LORE_NOTARY_APPLE_ID) {
    args.push(
      "--apple-id",
      process.env.LORE_NOTARY_APPLE_ID,
      "--password",
      requireEnv("LORE_NOTARY_PASSWORD"),
      "--team-id",
      requireEnv("LORE_NOTARY_TEAM_ID"),
    );
  } else {
    throw new Error(
      "notarization requires LORE_NOTARY_KEY (with LORE_NOTARY_KEY_ID and LORE_NOTARY_ISSUER) " +
        "or LORE_NOTARY_APPLE_ID (with LORE_NOTARY_PASSWORD and LORE_NOTARY_TEAM_ID)",
    );
  }
  const output = run("xcrun", args, { capture: true });
  process.stdout.write(output);
  const submission = output.match(/id:\s*([0-9a-fA-F-]{36})/);
  const accepted = /"status"\s*:\s*"Accepted"/.test(output) || /status:\s*Accepted/.test(output);
  if (!accepted) {
    throw new Error(`notarization was not accepted for ${path.basename(zip)}`);
  }
  return { zip, submissionId: submission ? submission[1] : null, status: "Accepted" };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function hostTarget() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = output.match(/host:\s*(\S+)/);
  if (!match) throw new Error("cannot determine host target");
  return match[1];
}

function workspaceVersion(repoRoot) {
  const manifest = readFileSync(path.join(repoRoot, "daemon/Cargo.toml"), "utf8");
  const section = manifest.split("[workspace.package]")[1] ?? "";
  const match = section.match(/version\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("cannot read workspace version");
  return match[1];
}

function sbom(repoRoot) {
  try {
    const output = execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--offline", "--manifest-path", path.join(repoRoot, "daemon/Cargo.toml")],
      // A store without the full dependency cache cannot produce an SBOM;
      // that must not spray cargo noise into a signing run.
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
    const metadata = JSON.parse(output);
    const workspace = new Set(metadata.packages.filter((entry) => metadata.workspace_members.includes(entry.id)).map((entry) => entry.id));
    const packages = metadata.packages
      .filter((entry) => !workspace.has(entry.id))
      .map((entry) => ({
        name: entry.name,
        version: entry.version,
        license: entry.license ?? null,
        source: entry.source ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return { format: "lore-sbom-v1", source: "cargo metadata --offline", packages };
  } catch (error) {
    return { format: "lore-sbom-v1", source: "unavailable", reason: String(error.message ?? error), packages: [] };
  }
}

function listFiles(root, prefix = "") {
  const entries = [];
  for (const name of readdirSync(root).sort()) {
    const full = path.join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) entries.push(...listFiles(full, relative));
    else entries.push(relative);
  }
  return entries;
}

function build(options) {
  const repoRoot = options.repoRoot;
  const target = options.target ?? hostTarget();
  const version = workspaceVersion(repoRoot);
  const dist = path.resolve(options.dist ?? path.join(repoRoot, "daemon/dist"));
  mkdirSync(dist, { recursive: true });

  if (!options.skipBuild && !options.binaryDir) {
    execFileSync("cargo", ["build", "--release", "--manifest-path", path.join(repoRoot, "daemon/Cargo.toml")], {
      stdio: "inherit",
    });
  }
  const binaryDir = options.binaryDir ?? path.join(repoRoot, "daemon/target/release");
  const stage = path.join(dist, `lore-${version}-${target}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(path.join(stage, "bin"), { recursive: true });
  mkdirSync(path.join(stage, "capabilities"), { recursive: true });

  for (const binary of ["lore", "lored"]) {
    const source = path.join(binaryDir, binary);
    if (!existsSync(source)) throw new Error(`missing release binary: ${source}`);
    copyFileSync(source, path.join(stage, "bin", binary));
  }
  cpSync(path.join(repoRoot, "daemon/clients"), path.join(stage, "clients"), { recursive: true });
  copyFileSync(
    path.join(repoRoot, "daemon/clients/capability-catalog.json"),
    path.join(stage, "capabilities/capability-catalog.json"),
  );
  const license = path.join(repoRoot, "LICENSE");
  if (existsSync(license)) copyFileSync(license, path.join(stage, "LICENSE"));

  writeFileSync(
    path.join(stage, "VERSION.json"),
    `${JSON.stringify({ version, target, builtMs: Date.now() }, null, 2)}\n`,
  );
  writeFileSync(path.join(stage, "SBOM.json"), `${JSON.stringify(sbom(repoRoot), null, 2)}\n`);

  // Sign before hashing: the manifest and checksums must cover the bytes that
  // are actually shipped.
  const signRequested = options.sign || process.env.LORE_CODESIGN === "1";
  const notarizeRequested = options.notarize || process.env.LORE_NOTARY === "1";
  if (notarizeRequested && !signRequested) {
    throw new Error("notarization requires signing: pass --sign (or LORE_CODESIGN=1)");
  }
  let signature = "unsigned-development-build";
  let notarization = null;
  if (signRequested && !target.includes("darwin")) {
    throw new Error("signing and notarization apply to macOS targets only");
  }
  if (signRequested) {
    const identity = codesignStage(stage, target);
    signature = notarizeRequested ? "signed-pending-notarization" : "signed";
    writeFileSync(
      path.join(stage, "SIGNATURE.json"),
      `${JSON.stringify({ identity, target, signedMs: Date.now() }, null, 2)}\n`,
    );
  }

  const files = listFiles(stage).map((relative) => {
    const full = path.join(stage, relative);
    return { path: relative, bytes: statSync(full).size, sha256: sha256(full) };
  });
  writeFileSync(
    path.join(stage, "MANIFEST.json"),
    `${JSON.stringify({ version, target, files }, null, 2)}\n`,
  );

  const archive = path.join(dist, `lore-${version}-${target}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", dist, path.basename(stage)]);
  const archiveHash = sha256(archive);
  writeFileSync(`${archive}.sha256`, `${archiveHash}  ${path.basename(archive)}\n`);
  const checksums = path.join(dist, "checksums.txt");
  const existing = existsSync(checksums) ? readFileSync(checksums, "utf8") : "";
  const line = `${archiveHash}  ${path.basename(archive)}`;
  if (!existing.split("\n").includes(line)) {
    writeFileSync(checksums, `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${line}\n`);
  }
  if (notarizeRequested) {
    notarization = notarizeStage(stage, dist, version, target);
    signature = "signed-notarized";
  }
  rmSync(stage, { recursive: true, force: true });

  return {
    archive,
    version,
    target,
    files: files.length,
    sha256: archiveHash,
    signature,
    notarization,
  };
}

function verify(archive) {
  const checksumFile = `${archive}.sha256`;
  if (!existsSync(checksumFile)) throw new Error(`missing checksum file: ${checksumFile}`);
  const expected = readFileSync(checksumFile, "utf8").trim().split(/\s+/)[0];
  const actual = sha256(archive);
  if (expected !== actual) {
    throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);
  }
  const temp = mkdtempSync(path.join(tmpdir(), "lore-verify-"));
  try {
    execFileSync("tar", ["-xzf", archive, "-C", temp]);
    const root = path.join(temp, readdirSync(temp)[0]);
    const manifest = JSON.parse(readFileSync(path.join(root, "MANIFEST.json"), "utf8"));
    for (const entry of manifest.files) {
      const full = path.join(root, entry.path);
      if (!existsSync(full)) throw new Error(`manifest entry missing: ${entry.path}`);
      const digest = sha256(full);
      if (digest !== entry.sha256) throw new Error(`file checksum mismatch: ${entry.path}`);
    }
    return { archive, version: manifest.version, target: manifest.target, verified: true, files: manifest.files.length };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
try {
  const result = options.verify ? verify(path.resolve(options.verify)) : build(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`package: ${error.message}\n`);
  process.exitCode = 1;
}
