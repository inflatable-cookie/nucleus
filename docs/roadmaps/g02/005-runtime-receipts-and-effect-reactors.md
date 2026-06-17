# 005 Runtime Receipts And Effect Reactors

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Define and implement the first runtime receipt path and effect reactor boundary.

This milestone is the bridge between command admission and real side effects.
It should prove how effects are requested, executed, recorded, retried, and
projected without choosing a full provider harness yet.

## Governing Refs

- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/022-engine-orchestration-boundary-contract.md`
- `docs/contracts/028-host-execution-safety-and-artifact-policy.md`
- `docs/architecture/system-architecture.md`

## Goals

- [x] Define effect intent and runtime receipt boundaries in code.
- [x] Connect one existing read-only command runner proof path to receipts.
- [x] Record progress/status without replaying side effects.
- [x] Keep provider harness runtime out of scope.
- [x] Keep receipt payloads sanitized and artifact-backed.

## Execution Plan

- [x] Receipt model batch: add code types for effect intent, runtime receipt,
  progress status, and artifact refs.
- [x] Reactor boundary batch: define host-owned effect reactor traits and a
  read-only command runner adapter.
- [x] Projection batch: expose a receipt/progress read model for diagnostics.
- [x] Validation batch: prove replay does not re-run effects.

## Acceptance Criteria

- [x] Side effects are represented by receipts and progress events.
- [x] Replay can rebuild receipt projections without executing commands.
- [x] Existing command evidence behavior is preserved or explicitly migrated.
- [x] Sanitization rules from the storage and runtime contracts are enforced in
  tests.

## Gate

Do not start until `004-task-timeline-and-history-projection.md` is complete or
explicitly superseded by an approved runtime receipt contract update.

## Outcome

- Added engine-owned runtime receipt record, status, family, ref, and codec
  types.
- Stored read-only command runtime receipts in the server runtime effects
  domain after sanitized command evidence is persisted.
- Added typed runtime receipt query support through runtime metadata.
- Added compact response DTOs for runtime receipt records.
- Preserved existing command evidence behavior.
- Kept provider harness runtime, SCM effects, live subscriptions, and raw
  stdout/stderr out of scope.
