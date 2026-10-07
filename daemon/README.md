# Lore v2 daemon (G1 proof)

Additive scaffold for the Rust `lored` + `lore` workspace described in
[`docs/v2/01-contracts.md`](../docs/v2/01-contracts.md). Nothing here is wired
into v1: no hooks, no installers, no database access, no support claims, no
change to any client.

## What exists

- `crates/protocol` — wire envelope, Status request/response and error types,
  with schema/type parity tests against `schemas/v2/`.
- `crates/lored` — `POST /v2/status` over a Unix socket with Host,
  content-type, body-size, store-ID and API-major validation.
- `crates/lore` — `lore status` CLI plus the shared hyper-over-`UnixStream`
  client used by tests.
- `schemas/v2/*.schema.json` — JSON Schema 2020-12 contract documents.
- `clients/node/status-client.mjs` — Node client proof using
  `node:http` + `socketPath`.

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
LORED_BIN=$PWD/daemon/target/debug/lored node --test daemon/clients/node/status-client.test.mjs
```

## G1 status

Proven locally:

- socket round trip with a contract-shaped Status result;
- Host, content-type, method, unknown-route, oversized-body and malformed-JSON
  rejection;
- store-ID and API-major preconditions, `INVALID_DEADLINE`;
- schema/type parity between `protocol` types and `schemas/v2/`;
- Node client and Rust CLI exchange over the same socket;
- a Linux CI job (fmt, clippy, tests, Node proof) with Cargo caching;
- preliminary cold CLI cost in a debug build: median 4.4 ms over 5 runs.

Not yet done (G1 has **not** passed):

- deadline enforcement beyond the zero-deadline rejection, plus
  cancellation/disconnect semantics;
- release-build cold-process measurement with recorded toolchain and hashes;
- frozen fixtures under `tests/v2/fixtures/`;
- macOS CI (Linux CI is wired in `.github/workflows/ci.yml`);
- the G1 evidence record and explicit go/no-go.
