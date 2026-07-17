# 044 Persistence Correctness Hardening

Status: planned
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

- [ ] Make revision CAS atomic: transaction-wrapped check+write or SQL
  conditional update with changed-row inspection in
  `nucleus-local-store/src/sqlite.rs`.
- [ ] Connection hygiene: shared connection (or pool) behind the state
  service, WAL, `busy_timeout`, schema initialized once, not per operation.
- [ ] Add a monotonic sequence column to the event journal; order replay and
  cursors by it, replacing lexicographic event-id ordering.
- [ ] Atomic projection materialization: temp file + fsync + rename in
  `accepted_memory_projection_file_materialization`.
- [ ] Replace stringly `reason: String` store errors with typed variants that
  distinguish busy, conflict, and corruption (retryable vs fatal).

## Goals

- [ ] two concurrent writers cannot both pass the same `Exact` revision
- [ ] projections replay in append order under any command-id scheme

## Acceptance Criteria

- [ ] multi-thread CAS test proves lost-update prevention
- [ ] replay test with unsorted command ids proves sequence ordering
- [ ] kill-mid-write test (or fault injection) leaves no truncated
  projection file
- [ ] `LocalStoreError` implements `Display` + `Error` with structured
  variants

## Batch Cards

Planned:

- `batch-cards/205-transactional-cas-and-connection-hygiene.md`
- `batch-cards/206-monotonic-event-sequencing.md`
- `batch-cards/207-atomic-materialization-and-typed-errors.md`
