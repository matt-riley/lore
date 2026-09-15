# Later slices: implementation index

Status: fully planned; implementation remains gated by G3.
Parent: [roadmap](README.md).

This document preserves the old navigation anchors. Detailed requirements now live in the linked implementation plans; it is no longer an outline awaiting expansion.

## Slice 4: background transcript ingestion

Read [background ingestion](04-ingestion.md): approved roots, all five source adapters, versioned Rust parsers, source identity, durable checkpoint transactions, branches/compaction, large records, fairness and capture accounting. Gate G4 includes all source dispositions and restart evidence.

## Slice 5: extraction and migration

Read [5A extraction and complete context](05-extraction.md), then [5B migration and recovery](05-migration-recovery.md). Extraction preserves role/evidence/manual authority and all required context sections; migration accounts for released schemas and enforces suppression-safe restore. G4 validates behavior before G5 allows real-data cutover.

## Slice 6: thin client adapters

Read [6A client adapters](06-client-adapters.md) and [6B administration/dashboard](06-administration-dashboard.md). Complete the [capability ledger](capability-parity.md), including optional operations, aliases and the read-only dashboard. Host certification cannot be inferred from socket tests.

## Slice 7: rollout and fallback

Read [rollout](07-rollout.md): native artifacts, opt-in per-user services, installer ownership, single-mode cutover, upgrades, safe recovery and all-client soak. This release has no automatic read/write v1 fallback after v2 activation. v1 retirement requires the complete G6 evidence.

## Shared acceptance documents

[Architecture decisions](architecture-decisions.md), [configuration/storage](configuration-storage.md), [protocol](01-contracts.md), [validation](validation.md) and [review disposition](review-disposition.md) apply throughout. Update them with intentional changes instead of adding contradictory per-slice defaults.
