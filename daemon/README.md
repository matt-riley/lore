# Lore v2 daemon

Rust `lored` + `lore` workspace implementing the roadmap in
[`docs/v2/01-contracts.md`](../docs/v2/01-contracts.md) and
[`docs/v2/02-daemon-core.md`](../docs/v2/02-daemon-core.md). Additive: no v1
hooks, installers, database imports or support-claim changes.

## Crates

- `crates/protocol` — wire types plus JSON Schema parity and fixture tests.
- `crates/lore-core` — configuration, SQLite store, policy, retrieval and
  store/endpoint lifecycle.
- `crates/lored` — daemon: config-driven startup, ownership locks, routes,
  admission bounds and deadline handling.
- `crates/lore` — CLI (`status`, `tool <name>`) and the shared socket client.
- `crates/repository-identity` — v1-compatible repository identity.
- `schemas/v2/` — JSON Schema 2020-12 contract documents.
- `clients/js/` — Node/Bun client, probe and harness.

## Routes and storage

`POST /v2/status`, `/v2/retain`, `/v2/forget` and `/v2/recall` over a Unix
socket. Memory lives in SQLite (WAL, `synchronous=FULL`, FTS5) with
idempotency receipts, ID tombstones, content-fingerprint suppression, scope
policy and maintained counters. Advertised capabilities are only
`status.basic`, `memory.retain.manual`, `memory.forget` and `recall.lexical`.

## Configuration

```json
{
  "configVersion": 2,
  "enabled": true,
  "dataDir": "/tmp/lore-v2",
  "socketPath": "/tmp/lore-v2/lored.sock"
}
```

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
```

## Gates

- G1 passed 2026-10-07 at `2e8bff4` — [evidence](../docs/v2/evidence/g1.md).
- G2 passed 2026-10-07 — [evidence](../docs/v2/evidence/g2.md).

Not yet implemented: embeddings and jobs (stage 3), ingestion (stage 4),
extraction and migration (stage 5), adapters and administration (stage 6),
packaging and cutover (stage 7).
