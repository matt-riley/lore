# Signing and notarizing macOS artifacts

Status: plumbing implemented, credentials pending. Until the secrets in
[Secrets](#4-add-the-repository-secrets) exist, every macOS build is an
unsigned development build and reports exactly that
(`signature: unsigned-development-build`) — the pipeline never labels an
unsigned artifact as signed.

This runbook is for whoever holds the Apple Developer account. Steps 1–3 need
an Apple account; step 4 needs repository admin; steps 5–7 can be verified by
anyone.

## What is produced

| Artifact | Purpose | Stapled |
| --- | --- | --- |
| `lore-<version>-<target>.tar.gz` | portable install, checksums + manifest | n/a |
| `lore-<version>-<target>.zip` | notarization submission for macOS | no — ticket is online |
| `checksums-<os>.txt` | per-platform SHA-256 list (one per release leg) | n/a |
| `SIGNATURE.json` (inside the archive) | identity and signing time | n/a |

`.zip` cannot be stapled. Gatekeeper validates the ticket online on first run,
so the first launch of a downloaded build requires network access once. If
offline-verifiable distribution becomes a requirement, add a `.pkg` build
(`pkgbuild --root <stage> --identifier dev.lore.lored --version <version>`)
and staple that instead — `stapler` only accepts `.pkg` and `.dmg`.

## 1. Create the signing certificate

1. Enroll in the Apple Developer Program (the free tier cannot notarize).
2. Xcode → Settings → Accounts → Manage Certificates → **+** →
   *Developer ID Application*. This is the certificate that allows
   distribution outside the App Store and is the only one notarization
   accepts.
3. Confirm it exists:

   ```sh
   security find-identity -v -p codesigning
   # 1) <HASH> "Developer ID Application: Your Name (TEAMID)"
   ```

4. Export it for CI: Keychain Access → find the certificate → right-click →
   *Export* → `.p12` → set a password. Export only the certificate and its
   private key, not the whole keychain, and do not include the CA bundle.
   Base64 the file:

   ```sh
   base64 -i DeveloperID.p12 | pbcopy
   ```

## 2. Create a notary API key

Prefer an App Store Connect API key over an Apple ID: it is revocable, does
not require 2FA on a runner, and does not need an app-specific password.

1. App Store Connect → Users and Access → Integrations → **App Store Connect
   API** → **+**. Name it `lore-notary`, role **Developer**.
2. Record the **Key ID** and **Issuer ID**, then download the `.p8` — it can
   only be downloaded once.
3. If you must use an Apple ID instead, create an app-specific password and
   plan to supply `LORE_NOTARY_APPLE_ID`, `LORE_NOTARY_PASSWORD` and
   `LORE_NOTARY_TEAM_ID`.

## 3. Sign and notarize locally (optional but recommended first)

```sh
cd daemon
cargo build --release

# Sign only: codesigns both binaries with the hardened runtime and a
# secure timestamp, then verifies each signature it just applied.
LORE_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  node scripts/package.mjs --skip-build --dist dist --sign

# Sign and notarize: also zips the staged build, submits it and waits for
# the verdict. Any status other than Accepted fails the run.
LORE_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
LORE_NOTARY_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_XXXX.p8" \
LORE_NOTARY_KEY_ID="XXXX" \
LORE_NOTARY_ISSUER="00000000-0000-0000-0000-000000000000" \
  node scripts/package.mjs --skip-build --dist dist --sign --notarize
```

Checks that must pass on the produced archive:

```sh
tar -xzf dist/lore-<version>-<target>.tar.gz -C /tmp/verify
codesign --verify --strict --verbose=2 /tmp/verify/*/bin/lored
codesign --display --verbose=2 /tmp/verify/*/bin/lored 2>&1 | grep runtime
xcrun stapler validate dist/lore-<version>-<target>.zip   # informational for zip
```

## 4. Add the repository secrets

Repository → Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `LORE_CODESIGN_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` — its presence enables signing |
| `LORE_SIGNING_CERTIFICATE_BASE64` | `base64` of the exported `.p12` |
| `LORE_SIGNING_CERTIFICATE_PASSWORD` | password chosen during export |
| `LORE_SIGNING_KEYCHAIN_PASSWORD` | any strong throwaway password for the temporary keychain |
| `LORE_NOTARY_KEY` | `base64` of the `.p8` |
| `LORE_NOTARY_KEY_ID` | Key ID from step 2 |
| `LORE_NOTARY_ISSUER` | Issuer ID from step 2 |

`LORE_NOTARY_KEY` is stored base64-encoded because secrets cannot hold
multi-line files; the workflow decodes it to a `0600` file on the runner.

## 5. What CI does

`.github/workflows/daemon-artifacts.yml`:

1. Builds release binaries on Ubuntu and macOS runners.
2. On macOS, when `LORE_CODESIGN_IDENTITY` is set, imports the `.p12` into a
   temporary keychain and runs `security find-identity` so a bad certificate
   fails before any work is signed.
3. Packages with `--sign`, and with `--notarize` when the notary key is
   present. Both steps write only after `codesign --verify` accepts.
4. Verifies the archive (`package.mjs --verify`) and re-extracts the tarball
   to confirm the shipped binaries carry a valid signature and the hardened
   runtime flag.
5. Attaches `.tar.gz`, `.zip`, `.sha256` and a `checksums-<os>.txt` per platform to the release.

If a signature is requested and cannot be produced, the run fails — the
workflow never falls back to an unsigned artifact silently.

## 6. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `no identity found` | certificate not in the keychain, or keychain locked | re-import, `security unlock-keychain` |
| `The timestamp service is not available` | no network to Apple's TSA | signing requires network; notarization too |
| `Invalid: The signature does not include a secure timestamp` | `--timestamp` skipped | the script always passes it; check for a locally patched copy |
| `status: Invalid` with an architecture error | binary does not match the declared target | rebuild for the same triple |
| `status: Invalid` referencing entitlements | hardened runtime missing | confirm `--options runtime` in the packaging output |
| Gatekeeper blocks a build that was notarized | downloaded as `.zip` and no network | staple a `.pkg`/`.dmg` instead, or allow one online check |

## 7. Verifying a release without credentials

```sh
shasum -a 256 -c lore-<version>-<target>.tar.gz.sha256
node daemon/scripts/package.mjs --verify lore-<version>-<target>.tar.gz
```

Both the checksum and the archive's internal `MANIFEST.json` must pass; the
verify path rejects a tampered archive. `SIGNATURE.json` inside the archive
records the identity and signing time when the build was signed.
