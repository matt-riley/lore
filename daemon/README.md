# Lore v2 daemon (G1 proof)

Additive scaffold for the Rust `lored` + `lore` workspace described in
[`docs/v2/01-contracts.md`](../docs/v2/01-contracts.md). Nothing here is wired
into v1: no hooks, no installers, no database access, no support claims, no
change to any client.

## What exists

- `crates/protocol` — wire envelope, Status request/response and error types,
  with schema/type parity tests against `schemas/v2/`.
- `crates/lored` — `POST /v2/status` over a Unix socket with Host,
  content-type, body-size, number-safety, deadline and overload validation.
- `crates/lore` — `lore status` CLI plus the shared hyper-over-`UnixStream`
  client used by tests.
- `crates/repository-identity` — v1-compatible repository identity resolution
  with cross-language fixtures.
- `schemas/v2/*.schema.json` — JSON Schema 2020-12 contract documents.
- `clients/js/` — Status client and probe that run unchanged under both Node
  and Bun (the Pi runtime).

## Build and test

Rust 1.99.0 is pinned in `rust-toolchain.toml`. With mise:

```sh
mise exec rust@1.99.0 -- cargo test --manifest-path daemon/Cargo.toml
```

Manual proof:

```sh
mise exec rust@1.99.0 -- cargo build --manifest-path daemon/Cargo.toml
daemon/target/debug/lored --socket /tmp/lore-v2.sock --store-id store-dev &
daemon/target/debug/lore status --socket /tmp/lore-v2.sock
LORED_BIN=$PWD/daemon/target/debug/lored node daemon/clients/js/status-probe.mjs
LORED_BIN=$PWD/daemon/target/debug/lored bun  daemon/clients/js/status-probe.mjs
```

## G1 status

Passed 2026-10-07 at `ebef6d6` — full record in
[`docs/v2/evidence/g1.md`](../docs/v2/evidence/g1.md).

Proven locally and in CI:

- socket round trip with a contract-shaped Status result;
- Host, content-type, method, unknown-route, duplicate-key, NaN/Infinity,
  nesting-limit, unsafe-integer, oversized-body and malformed-JSON rejection;
- store-ID and API-major preconditions, zero-deadline rejection, the 1s
  header/body receive deadline and the clamped operation deadline;
- bounded in-flight overload with 429 rejection and recovery;
- client-disconnect safety and refusal to replace a live socket;
- schema/type parity between `protocol` types and `schemas/v2/`;
- repository identity parity with v1 through shared fixtures;
- Node, Bun and Rust CLI clients exchanging the same protocol;
- macOS and Linux CI jobs (fmt, clippy, tests, both client probes) with Cargo
  caching;
- preliminary cold CLI cost in a debug build: median 4.4 ms over 5 runs.

Next: stage 2 — durable Status, Retain, Forget and lexical Recall per
[`docs/v2/02-daemon-core.md`](../docs/v2/02-daemon-core.md).
