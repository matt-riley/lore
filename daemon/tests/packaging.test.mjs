// Packaging proofs: layout, checksums, manifest verification and tamper
// rejection. Uses fake binaries so the test never builds a release artifact.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "daemon/scripts/package.mjs");

function run(args, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runExpectingFailure(args, env = {}) {
  try {
    run(args, env);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  throw new Error("expected the packaging run to fail");
}

function fakeBinaries(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of ["lore", "lored"]) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho ${name} 0.1.0\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

test("packaging builds an archive with manifest, checksums and an SBOM", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-package-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binaries = fakeBinaries(path.join(dir, "bin"));
  const result = JSON.parse(
    run([
      "--skip-build",
      "--binary-dir",
      binaries,
      "--dist",
      path.join(dir, "dist"),
      "--target",
      "test-target",
    ]),
  );
  assert.equal(result.target, "test-target");
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.signature, "unsigned-development-build");
  assert.ok(existsSync(result.archive));
  assert.ok(existsSync(`${result.archive}.sha256`));
  assert.ok(existsSync(path.join(dir, "dist/checksums.txt")));

  const verified = JSON.parse(run(["--verify", result.archive]));
  assert.equal(verified.verified, true);
  assert.equal(verified.target, "test-target");
  assert.ok(verified.files > 5, "manifest covers binaries, clients and metadata");
});

test("packaging rejects a tampered archive", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-package-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binaries = fakeBinaries(path.join(dir, "bin"));
  const result = JSON.parse(
    run([
      "--skip-build",
      "--binary-dir",
      binaries,
      "--dist",
      path.join(dir, "dist"),
      "--target",
      "test-target",
    ]),
  );
  const bytes = readFileSync(result.archive);
  writeFileSync(result.archive, Buffer.concat([bytes, Buffer.from("tampered")]));
  assert.throws(() => run(["--verify", result.archive]), /checksum mismatch/);
});

test("packaged metadata names the capability catalog and clients", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-package-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binaries = fakeBinaries(path.join(dir, "bin"));
  const result = JSON.parse(
    run([
      "--skip-build",
      "--binary-dir",
      binaries,
      "--dist",
      path.join(dir, "dist"),
      "--target",
      "test-target",
    ]),
  );
  const extract = mkdtempSync(path.join(tmpdir(), "lore-extract-"));
  t.after(() => rmSync(extract, { recursive: true, force: true }));
  execFileSync("tar", ["-xzf", result.archive, "-C", extract]);
  const packageRoot = path.join(extract, readdirSync(extract)[0]);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "MANIFEST.json"), "utf8"));
  const paths = manifest.files.map((entry) => entry.path);
  assert.ok(paths.includes("bin/lore"));
  assert.ok(paths.includes("bin/lored"));
  assert.ok(paths.includes("capabilities/capability-catalog.json"));
  assert.ok(paths.some((entry) => entry.startsWith("clients/js/")));
  assert.ok(paths.some((entry) => entry.startsWith("clients/pi/")));
  assert.ok(paths.some((entry) => entry.startsWith("clients/copilot/")));
  const sbom = JSON.parse(readFileSync(path.join(packageRoot, "SBOM.json"), "utf8"));
  assert.equal(sbom.format, "lore-sbom-v1");
  assert.ok(Array.isArray(sbom.packages));
});

test("packaging refuses signing and notarization without credentials", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-package-sign-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binaries = fakeBinaries(path.join(dir, "bin"));
  const base = [
    "--skip-build",
    "--binary-dir",
    binaries,
    "--dist",
    path.join(dir, "dist"),
    "--target",
    "aarch64-apple-darwin",
  ];
  const clean = { LORE_CODESIGN_IDENTITY: "", LORE_NOTARY_KEY: "", LORE_NOTARY_APPLE_ID: "" };

  // --sign without an identity fails loudly; an unsigned artifact is never
  // labelled signed.
  const missingIdentity = runExpectingFailure([...base, "--sign"], clean);
  assert.match(missingIdentity, /LORE_CODESIGN_IDENTITY is required/);

  // --notarize implies --sign.
  const notarizeOnly = runExpectingFailure([...base, "--notarize"], clean);
  assert.match(notarizeOnly, /notarization requires signing/);

  // Signing a non-macOS target is refused rather than silently skipped.
  const wrongTarget = runExpectingFailure(
    [
      "--skip-build",
      "--binary-dir",
      binaries,
      "--dist",
      path.join(dir, "dist"),
      "--target",
      "x86_64-unknown-linux-gnu",
      "--sign",
    ],
    { ...clean, LORE_CODESIGN_IDENTITY: "Developer ID Application: Test (TEAMID)" },
  );
  assert.match(wrongTarget, /macOS targets only/);

  // A requested signature is never silently skipped: either codesign is
  // missing (non-macOS runner), the identity is not in the keychain, or the
  // run fails — in every case no archive is produced. (The notary credential
  // branch runs after a successful codesign, so it is exercised in the
  // release workflow with real credentials, not here.)
  const unusableIdentity = runExpectingFailure(
    [
      "--skip-build",
      "--binary-dir",
      binaries,
      "--dist",
      path.join(dir, "dist"),
      "--target",
      "aarch64-apple-darwin",
      "--sign",
    ],
    { ...clean, LORE_CODESIGN_IDENTITY: "Developer ID Application: Test (TEAMID)" },
  );
  assert.match(unusableIdentity, /codesign/);
  assert.match(
    unusableIdentity,
    /codesign is required|no identity found|Developer ID Application: Test \(TEAMID\)|codesign ENOENT/,
  );
  assert.ok(
    !readdirSync(path.join(dir, "dist")).some((entry) => entry.endsWith(".tar.gz")),
    "a refused signature must not leave a publishable archive",
  );

  // The unsigned path is still available and honest about it.
  const unsigned = JSON.parse(run(base, clean));
  assert.equal(unsigned.signature, "unsigned-development-build");
  assert.equal(unsigned.notarization, null);
});
