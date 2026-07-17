# 044 Persistence Correctness Hardening

Status: completed
Owner: Tom
Updated: 2026-07-17

## Purpose

Fix the storage-layer correctness holes: racy optimistic concurrency,
unordered event replay, per-operation connections, and non-atomic projection
file writes.

Audit basis: `../../logs/2026-07-17-codebase-audit-findings.md` (critical
findings 2-3, high persistence items).

## Governing Refs

- `../../contracts/008-storage-state-persistence-contract.md`
- `../../contracts/018-orchestration-contract.md`

## Execution Plan

- [x] Make revision CAS atomic: transaction-wrapped check+write or SQL
  conditional update with changed-row inspection in
  `nucleus-local-store/src/sqlite.rs`.
- [x] Connection hygiene: shared connection (or pool) behind the state
  service, WAL, `busy_timeout`, schema initialized once, not per operation.
- [x] Add a monotonic sequence column to the event journal; order replay by
  it, replacing lexicographic event-id ordering (numeric cursor type
  deferred until orchestration replay consumes cursors).
- [x] Atomic projection materialization: temp file + fsync + rename in
  `accepted_memory_projection_file_materialization`.
- [x] Replace stringly `reason: String` store errors with typed variants that
  distinguish busy, conflict, and corruption (retryable vs fatal).

## Goals

- [x] two concurrent writers cannot both pass the same `Exact` revision
- [x] projections replay in append order under any command-id scheme

## Acceptance Criteria

- [x] multi-thread CAS test proves lost-update prevention (two backends,
  separate connections, exactly one `Exact` writer wins)
- [x] replay test with unsorted command ids proves sequence ordering
- [x] crash-safety by construction: rename-based swap means a crash
  mid-write leaves the previous file intact (no fault-injection harness yet;
  revisit if materialization grows multi-file writes)
- [x] `LocalStoreError` implements `Display` + `Error` with structured
  variants

## Batch Cards

Planned:

- `batch-cards/205-transactional-cas-and-connection-hygiene.md`
- `batch-cards/206-monotonic-event-sequencing.md`
- `batch-cards/207-atomic-materialization-and-typed-errors.md`
