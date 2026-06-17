# 002 Event Store Persistence Hardening

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Harden the first orchestration event-journal proof into a safer event-store
foundation.

`001-orchestration-and-engine-boundary.md` proved that task command admission
can flow through `nucleus-orchestration`, append a replayable event before
mutation, and rebuild a projection from the journal. This milestone turns that
proof into a clearer persistence boundary before wider command, runtime, SCM,
or client work depends on it.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/022-engine-orchestration-boundary-contract.md`
- `docs/architecture/engine-orchestration-boundary.md`
- `docs/roadmaps/g02/001-orchestration-and-engine-boundary.md`

## Goals

- [x] Define the event-store record envelope and codec boundary.
- [x] Add a repository boundary so orchestration code does not depend on
  server persistence internals.
- [x] Preserve stable event identity, sequencing, command causality, stream
  refs, schema versions, and projection cursors.
- [x] Keep replay deterministic and side-effect free.
- [x] Add validation coverage for event append, decode, projection rebuild, and
  malformed-record rejection.
- [x] Keep provider runtime, SCM mutation, remote transport, and UI panels out
  of scope.

## Execution Plan

- [x] Record envelope batch: define event-store records and codec tests.
- [x] Repository batch: introduce a storage-agnostic event-store trait and
  server adapter.
- [x] Replay batch: rebuild command-admission projection through the repository
  boundary and assert deterministic output.
- [x] Validation batch: run focused Rust and Northstar checks, then update the
  milestone outcome.

## Acceptance Criteria

- [x] Orchestration event persistence no longer writes raw server records from
  request-handler code directly.
- [x] Event records include enough identity and cursor data for replay and
  projection provenance.
- [x] Malformed orchestration event records fail closed and are surfaced as
  storage/projection errors.
- [x] Projection rebuild reads through a repository boundary, not ad hoc
  request-handler journal scanning.
- [x] Existing task command admission behavior still passes.
- [x] `cargo check --workspace`, focused Rust tests, `effigy qa:docs`, and
  `effigy qa:northstar` pass.

## Stop Conditions

- The work starts implementing provider runtime ingestion, SCM mutation, remote
  host transport, or UI event timelines.
- Event replay would re-run external side effects.
- Storage changes assume SQLite-only behavior instead of adapter-backed
  repository traits.
- The milestone starts creating micro-cards instead of executing the grouped
  batches listed below.

## Cards

- `batch-cards/001-event-store-record-contract-and-codec.md`
- `batch-cards/002-event-store-repository-boundary.md`
- `batch-cards/003-command-projection-replay-integrity.md`
- `batch-cards/004-event-store-hardening-validation.md`

## Outcome

- Added an orchestration-owned event-store envelope with stream ref, cursor,
  command causality, schema version, projection cursor, and typed payload.
- Added encode/decode validation that fails closed on malformed JSON and
  envelope / payload mismatches.
- Added `OrchestrationEventStoreRepository` as the storage-agnostic append/read
  boundary.
- Added the current server local-store adapter for orchestration events.
- Routed command-admitted event append and command-admission projection rebuild
  through the repository boundary.
- Added deterministic projection replay coverage and malformed-record
  rejection coverage.
- Kept provider runtime, SCM mutation, remote transport, and UI behavior out of
  scope.
