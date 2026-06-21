# 024 Convergence Local Snap Request Persistence

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Persist stopped Convergence local snap request records and expose read-only
control counts before a runner can execute `converge snap`.

## Governing Refs

- `docs/roadmaps/g03/023-convergence-local-snap-command-boundary.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [x] Persist stopped local snap requests with stable ids.
- [x] Preserve idempotency, replay, admission, descriptor, task, repo, and
  authority refs.
- [x] Expose read-only persistence diagnostics.
- [x] Keep command execution and remote effects false.

## Execution Plan

- [x] Request persistence batch.
- [x] Control DTO batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/085-convergence-local-snap-request-persistence.md`
- `batch-cards/086-convergence-local-snap-request-control-dto.md`
- `batch-cards/087-convergence-local-snap-request-persistence-closeout.md`

## Acceptance Criteria

- [x] Stopped local snap requests can be persisted.
- [x] Duplicate idempotency keys become deterministic no-op records.
- [x] Blocked requests remain inspectable.
- [x] No command spawn, actual `converge snap`, object upload, publication,
  lane sync, bundle, approval, promotion, release, resolution publication,
  provider write, task mutation, callback, interruption, recovery, or raw
  output effect is added.
