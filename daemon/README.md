# Lore v2 daemon

Rust `lored` + `lore` workspace implementing the roadmap in
[`docs/v2/01-contracts.md`](../docs/v2/01-contracts.md) and
[`docs/v2/02-daemon-core.md`](../docs/v2/02-daemon-core.md). Additive: no v1
hooks, installers, database imports or support-claim changes.

## Crates

- `crates/protocol` — wire types plus JSON Schema parity and fixture tests.
- `crates/lore-core` — configuration, SQLite store (schema 5 with embedding
  intents, jobs, vectors, source capture, memory evidence, extraction leases,
  migration manifests and repository mappings), policy, retrieval, extraction,
  ingestion, migration/backup and store/endpoint lifecycle.
- `crates/lore-provider` — OpenAI-compatible embedding client with contract-grade
  response validation.
- `crates/lored` — daemon: config-driven startup, ownership locks, routes,
  admission bounds and deadline handling.
- `crates/lore` — CLI (`status`, `tool <name>`) and the shared socket client.
- `crates/repository-identity` — v1-compatible repository identity.
- `schemas/v2/` — JSON Schema 2020-12 contract documents.
- `clients/js/` — Node/Bun client, probe and harness.

## Routes and storage

`POST /v2/status`, `/v2/retain`, `/v2/forget`, `/v2/recall`, `/v2/jobs/status`,
`/v2/jobs/retry`, `/v2/config/reload`, `/v2/sources/register`,
`/v2/sources/hint`, `/v2/sources/status`, `/v2/extraction/retry` and
`/v2/views/{overview,health,memories,memories/filters,maintenance,episodes,drilldown}`
and administration at
`/v2/admin/{search,explain,validate,doctor,audit/extractions,correct,purge,scope-override,scope-audit,run-status}`
over a Unix socket. The `lore` CLI adds capability-registry dispatch
(`lore tool`, `lore recall`), native hooks (`lore hook codex|claude|antigravity`),
the uncertain-write journal (`lore retries`) and the loopback dashboard
gateway (`lore browser`). Memory lives in
SQLite (WAL, `synchronous=FULL`, FTS5) with idempotency receipts, ID tombstones,
content-fingerprint suppression, scope policy and maintained counters.

Approved source roots (stage 4) are captured in bounded quanta under a
checkpoint compare-and-swap: per-client parsers normalize evidence, appends
continue a generation, replacement starts a new one, and a durable directory
cursor plus 60-second sweep catches missed notifications. Host session
databases are opened read-only and never migrated. Advertised capabilities
then include `sources.register`, `sources.hint`, `sources.status` and
`extraction.retry`. Deterministic rules (version `rules-v1`) turn verified
user and assistant evidence into scoped automatic memories with evidence
links, suppression checks and correction supersession; recall assembles
mandatory directives/identity/preferences before topical results.

With `providers.embeddings.enabled`, a background worker reconciles eligible
memories into materialized jobs, embeds them in bounded batches and stores
current vectors. Recall attempts one bounded query embedding (100 ms
allowance inside the 160 ms server budget), serves exact-key cache hits, and
falls back to lexical ranking with a reported reason. Advertised capabilities
then include `recall.semantic.bounded`, `embedding.status`, `embedding.retry`
and `config.reload`.

## Configuration

```json
{
  "configVersion": 2,
  "enabled": true,
  "dataDir": "/tmp/lore-v2",
  "socketPath": "/tmp/lore-v2/lored.sock",
  "providers": {
    "embeddings": {
      "enabled": true,
      "endpoint": "http://127.0.0.1:12434/v1",
      "model": "docker.io/ai/embeddinggemma:latest",
      "dimensions": 768,
      "generation": 1,
      "minSimilarity": 0.45
    }
  }
}
```

Embeddings are off unless enabled; dimensions are required; non-loopback
endpoints need `allowRemote: true`.

Source capture is off until a root is listed:

```json
{
  "sources": {
    "roots": [
      { "rootId": "pi-sessions", "client": "pi", "path": "/Users/me/.pi/agent/sessions", "repository": "owner/name" }
    ],
    "sweepSeconds": 60
  }
}
```

`repository` is optional and is the only path to `repositoryVerified`; path
hints never set it.

`enabled: false` serves Status with `CONFIG_DISABLED` and rejects memory
operations. Relative paths resolve against the config directory. A v1
`lore.db` inside `dataDir` is refused.

## Build and test

Rust 1.99.0 is pinned in `rust-toolchain.toml`. With mise:

```sh
mise exec rust@1.99.0 -- cargo test --manifest-path daemon/Cargo.toml
```

Client proofs (Node and Bun run the same code):

```sh
mise exec rust@1.99.0 -- cargo build --manifest-path daemon/Cargo.toml
LORED_BIN=$PWD/daemon/target/debug/lored node daemon/clients/js/status-probe.mjs
LORED_BIN=$PWD/daemon/target/debug/lored bun  daemon/clients/js/status-probe.mjs
LORED_BIN=$PWD/daemon/target/debug/lored node --test daemon/tests/two-client.test.mjs daemon/tests/lexical-quality.test.mjs
```

Lexical benchmarks (release build; writes a JSON report):

```sh
mise exec rust@1.99.0 -- cargo build --release --manifest-path daemon/Cargo.toml
LORED_BIN=$PWD/daemon/target/release/lored node daemon/tests/benchmark-lexical.mjs --count 10000 --queries 200
node daemon/tests/v1-lexical-baseline.mjs --count 10000 --queries 200
LORED_BIN=$PWD/daemon/target/release/lored node daemon/tests/benchmark-semantic.mjs --report /tmp/g3-latency.json
LORED_BIN=$PWD/daemon/target/debug/lored node daemon/tests/ingestion-load.mjs
```

Client surfaces:

```sh
cargo run -p lore -- capabilities --output json
cargo run -p lore -- --socket <sock> hook claude UserPromptSubmit < event.json
cargo run -p lore -- --socket <sock> tool lore_save --output json < retain.json
cargo run -p lore -- --socket <sock> search "release checklist"
cargo run -p lore -- --socket <sock> tool lore_doctor --output json
cargo run -p lore -- --socket <sock> tool lore_correct --output json < correct.json
cargo run -p lore -- --socket <sock> tool lore_purge --output json < purge.json
cargo run -p lore -- retries list
cargo run -p lore -- --socket <sock> browser
```

Offline administration (no daemon required):

```sh
cargo run -p lore -- migrate v1 --source <v1-db> --destination <dir> --dry-run
cargo run -p lore -- migrate v1 --source <v1-db> --destination <dir> --apply --plan <fp> --clients-stopped
cargo run -p lore -- migrate status --destination <dir> --run <id>
cargo run -p lore -- migrate resume --destination <dir> --run <id> --apply
cargo run -p lore -- backup --destination <file>
cargo run -p lore -- restore --from <file> [--dry-run | --apply --plan <fp> --clients-stopped]
```

Semantic quality (requires a configured local embedding provider; the default
is Docker Model Runner):

```sh
LORED_BIN=$PWD/daemon/target/debug/lored node daemon/tests/calibrate-threshold.mjs
LORED_BIN=$PWD/daemon/target/debug/lored node daemon/tests/semantic-quality.mjs --mode v2 --split held-out --threshold 0.45
node daemon/tests/semantic-quality.mjs --mode v1-semantic --split held-out --threshold 0.45
```

## Gates

- G1 passed 2026-10-07 at `2e8bff4` — [evidence](../docs/v2/evidence/g1.md).
- G2 passed 2026-10-07 — [evidence](../docs/v2/evidence/g2.md).
- G3 passed 2026-10-07 — [evidence](../docs/v2/evidence/g3.md) (one recorded
  fusion deviation).
- G4 stage-4 capture passed 2026-10-07 — [evidence](../docs/v2/evidence/g4.md).
- G4 stage-5A extraction passed 2026-10-07 —
  [evidence](../docs/v2/evidence/g4-extraction.md); section-parity gaps are
  recorded there.

- G5 stage-5B migration/recovery passed 2026-10-07 —
  [evidence](../docs/v2/evidence/g5-migration.md).
- G6 stage-6A/6B cores implemented 2026-10-07 —
  [evidence](../docs/v2/evidence/g6-clients-admin.md); host adapter evidence,
  the remaining canonical operations and full dashboard parity still required.

Not yet implemented: adapters and administration (stage 6), packaging and
cutover (stage 7).
