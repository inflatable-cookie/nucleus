# 028 Convergence Local Snap Runner Replay Boundary

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Persist stopped local snap command-adapter decisions as replayable records
before any real `converge snap` process execution.

## Governing Refs

- `docs/roadmaps/g03/027-convergence-local-snap-stopped-runner-command-adapter.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [x] Store stopped local snap command-adapter decisions with duplicate-safe
  replay ids.
- [x] Preserve persisted evidence, request, admission, task, repo,
  source-authority, execution-authority, and idempotency refs.
- [x] Add read-only diagnostics for replayed, duplicate, blocked, and skipped
  decisions.
- [x] Keep command execution and remote Convergence effects false.

## Execution Plan

- [x] Replay record batch.
- [x] Replay diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/097-convergence-local-snap-runner-replay-records.md`
- `batch-cards/098-convergence-local-snap-runner-replay-diagnostics.md`
- `batch-cards/099-convergence-local-snap-runner-replay-closeout.md`

## Acceptance Criteria

- [x] Runnable stopped adapter records can produce replay records.
- [x] Blocked, duplicate, and unsupported adapter records remain visible but
  cannot produce runnable replay effects.
- [x] Duplicate replay ids are deterministic no-ops.
- [x] No command spawn, actual `converge snap`, object upload, publication,
  lane sync, bundle, approval, promotion, release, resolution publication,
  provider write, task mutation, callback, interruption, recovery, or raw
  output effect is added.
