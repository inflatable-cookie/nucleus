# 023 Convergence Local Snap Command Boundary

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Define stopped local snap command descriptors and request records from admitted
Convergence local snap work, without invoking `converge snap`.

## Governing Refs

- `docs/roadmaps/g03/022-convergence-local-snap-admission.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [x] Build local snap command descriptors from admitted local snap records.
- [x] Define stopped request records with stable idempotency keys.
- [x] Preserve replay, admission, task, repo, and authority refs.
- [x] Keep command execution and all remote effects false.

## Execution Plan

- [x] Command descriptor batch.
- [x] Stopped request batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/082-convergence-local-snap-command-descriptors.md`
- `batch-cards/083-convergence-local-snap-stopped-requests.md`
- `batch-cards/084-convergence-local-snap-command-closeout.md`

## Acceptance Criteria

- [x] Descriptors derive only from admitted local snap records.
- [x] Stopped requests preserve idempotency and local snap authority refs.
- [x] Blocked, duplicate, or unsupported admissions cannot produce executable
  requests.
- [x] No command spawn, actual `converge snap`, object upload, publication,
  lane sync, bundle, approval, promotion, release, resolution publication,
  provider write, task mutation, callback, interruption, recovery, or raw
  output effect is added.
