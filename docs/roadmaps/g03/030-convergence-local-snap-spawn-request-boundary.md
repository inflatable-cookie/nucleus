# 030 Convergence Local Snap Spawn Request Boundary

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Describe a stopped process-spawn request for a future `converge snap` local
command without spawning the process.

## Governing Refs

- `docs/roadmaps/g03/029-convergence-local-snap-execution-preflight.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [x] Create stopped spawn-request records only from ready local snap execution
  preflight records.
- [x] Preserve preflight, replay, evidence, request, admission, task, repo,
  authority, and idempotency refs.
- [x] Add read-only diagnostics for ready, blocked, duplicate, and unsupported
  spawn-request states.
- [x] Keep process spawn, actual `converge snap`, object upload, publication,
  lane sync, provider writes, and task mutation false.

## Execution Plan

- [x] Spawn-request records batch.
- [x] Spawn-request diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/103-convergence-local-snap-spawn-request-records.md`
- `batch-cards/104-convergence-local-snap-spawn-request-diagnostics.md`
- `batch-cards/105-convergence-local-snap-spawn-request-closeout.md`

## Acceptance Criteria

- [x] Ready preflight records can produce stopped spawn-request records.
- [x] Blocked, duplicate, and unsupported preflight records remain inspectable
  but cannot produce ready spawn requests.
- [x] Duplicate spawn-request ids are deterministic no-ops.
- [x] No command spawn, actual `converge snap`, object upload, publication,
  lane sync, provider write, task mutation, callback, interruption, recovery,
  or raw output effect is added.
