# Using v2 locally

The v2 daemon is opt-in and side-by-side with v1. Nothing switches clients
over until you select the mode, and v1 keeps running until you uninstall it.

Prerequisites: Rust 1.99 (the repo pins it via `daemon/rust-toolchain.toml`;
`mise` is the easiest way to get it) and Node 24+ only if you want the host
adapters or the dashboard assets.

## 1. Build

```sh
cd daemon
cargo build --release        # or: mise exec rust@1.99.0 -- cargo build --release
```

The binaries land in `daemon/target/release/{lore,lored}`. Add them to `PATH`
or call them by path.

## 2. Create a config

`lored` needs a v2 config; all paths resolve relative to the config file when
not absolute.

```sh
mkdir -p "$HOME/.lore"
cat > "$HOME/.lore/lore.json" <<JSON
{
  "configVersion": 2,
  "enabled": true,
  "dataDir": "$HOME/.lore",
  "socketPath": "$HOME/.lore/lored.sock"
}
JSON
```

Paths are not tilde-expanded: write absolute paths (or paths relative to the
config file).

Optional blocks (all default off, all validated at startup):

```jsonc
{
  "sources": {
    "roots": [
      { "rootId": "pi", "client": "pi", "path": "/Users/you/.pi/agent/sessions" }
    ],
    "sweepSeconds": 60
  },
  "maintenance": {
    "tasks": { "memoryHygiene": { "enabled": true, "cadenceSeconds": 900 } }
  },
  "analysis": {
    "enabled": false,          // optional chat lane; key from LORE_ANALYSIS_API_KEY
    "endpoint": "http://127.0.0.1:8080/v1",
    "model": "your-model",
    "deadlineMs": 5000,
    "rerank": false            // optional fail-open recall rerank
  }
}
```

## 3. Run the daemon

```sh
~/lore/daemon/target/release/lored --config "$HOME/.lore/lore.json"
```

It prints the socket and store id and serves until stopped. `lore` and `lored`
take `--config`, or `--socket`/`--data-dir` when there is no config file.

## 4. Talk to it

```sh
export LORE="$HOME/lore/daemon/target/release/lore --config $HOME/.lore/lore.json"

$LORE status --json                                  # readiness, schema, revision
$LORE recall "release conventions" --output json     # query is positional
$LORE tool lore_retain --output json <<'JSON'        # model tools read JSON stdin
{ "idempotencyKey": "local-1", "type": "note",
  "content": "Prefer small pure functions.", "scope": "global" }
JSON
$LORE search "pure functions" --output json
$LORE browser --open                                 # loopback-only dashboard
```

Other verbs you will use day to day: `capabilities`, `retries`, `maintenance
--status`, `audit report`, `bundle visualize --bundle <dir>`,
`analyze --kind query-expansion` (JSON on stdin), and
`backup --destination <dir>` / `restore --from <snapshot> --apply`.

Verbs that act on the local installation rather than the daemon — `service`,
`setup`, `upgrade`, `mode` — print their own plan object or summary instead of
a daemon envelope, and `service install` points the unit at the config you
pass with `--config` (falling back to `<home>/.lore/lore.json`).

Write verbs refuse to run without an `idempotencyKey`; that is the retry
safety net, not a formality.

## 5. Install it as a service (optional)

```sh
LORE_BIN="$HOME/lore/daemon/target/release/lore"   # service commands use --home
$LORE_BIN --config "$HOME/.lore/lore.json" service install --dry-run
$LORE_BIN --config "$HOME/.lore/lore.json" service install --apply
$LORE_BIN service start --apply
$LORE_BIN service status --output json
```

Notes written by `service install` are owned by lore: reruns are idempotent,
edited files are never overwritten without `--replace-unowned`, and
`service uninstall` removes only owned, unmodified files.

## 6. Point clients at v2

Host adapters live in `daemon/clients/`. `setup` writes only files under
`~/.lore/integrations` and leaves host settings alone — it never edits a
host's own config.

```sh
$LORE setup --clients pi,copilot --dry-run --output json
$LORE setup --clients pi,copilot --apply
```

The Pi and Copilot adapters connect to the daemon socket
(`LORE_V2_SOCKET`, defaulting to the configured socket) and expose the nine
model tools. They fail open: if the daemon is down, the host keeps working.

## 7. Migrate v1 data (optional)

Migration is preview-first, forward-only, and never mutates the v1 source.

```sh
$LORE migrate v1 --source "$HOME/.lore/lore-v1.db" --destination "$HOME/.lore/v2" \
  --dry-run
$LORE migrate v1 --source "$HOME/.lore/lore-v1.db" --destination "$HOME/.lore/v2" \
  --apply --plan <fingerprint> --clients-stopped
$LORE migrate status --destination "$HOME/.lore/v2"
```

Take a backup first (`$LORE backup --destination /path/to/snapshots`), and read
[migration-guide.md](migration-guide.md) before running `--apply`.

## 8. Select the mode

```sh
$LORE mode status
$LORE mode select --mode v2 --dry-run
$LORE mode select --mode v2 --apply
```

Mode selection records the intent for installers and hooks; it does not
delete v1 or rewrite host settings. Reverting the record with
`--mode v1 --apply` stops new v2 use but does not remove migrated data.

## 9. Working on the daemon

```sh
cd daemon
cargo test                      # unit + integration suites
cargo clippy --all-targets -- -D warnings
cargo fmt --all
```

The daemon job in CI also runs the packaging proofs, a bounded soak and the
capability catalog check. `node daemon/tests/soak.mjs --seconds 15` runs the
soak locally against a built `lored` (`LORED_BIN`).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `CONFIG_REQUIRED` | pass `--config` or `--socket`/`--data-dir` |
| `STORE_ID_REQUIRED` | the client must send `expectedStoreId` from `status` |
| `MIGRATION_INCOMPLETE` | finish or clear the migration before using the store |
| `ANALYSIS_UNAVAILABLE` | `analysis.enabled` is false — the lane is opt-in |
| socket exists but nothing answers | an old daemon died; the next start clears a stale endpoint |
