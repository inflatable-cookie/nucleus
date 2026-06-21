# 031 Convergence Local Snap Spawn Handoff Boundary

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Describe a stopped handoff from ready local snap spawn requests to a future
process runner without invoking the runner.

## Governing Refs

- `docs/roadmaps/g03/030-convergence-local-snap-spawn-request-boundary.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [x] Create stopped handoff records only from ready local snap spawn requests.
- [x] Preserve spawn request, preflight, replay, evidence, task, repo,
  authority, and idempotency refs.
- [x] Add read-only diagnostics for ready, blocked, duplicate, and unsupported
  handoff states.
- [x] Keep process runner invocation, actual `converge snap`, object upload,
  publication, lane sync, provider writes, and task mutation false.

## Execution Plan

- [x] Spawn handoff records batch.
- [x] Spawn handoff diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/106-convergence-local-snap-spawn-handoff-records.md`
- `batch-cards/107-convergence-local-snap-spawn-handoff-diagnostics.md`
- `batch-cards/108-convergence-local-snap-spawn-handoff-closeout.md`

## Acceptance Criteria

- [x] Ready spawn requests can produce stopped handoff records.
- [x] Blocked, duplicate, and unsupported spawn requests remain inspectable but
  cannot produce ready handoff records.
- [x] Duplicate handoff ids are deterministic no-ops.
- [x] No command spawn, actual `converge snap`, object upload, publication,
  lane sync, provider write, task mutation, callback, interruption, recovery,
  or raw output effect is added.
