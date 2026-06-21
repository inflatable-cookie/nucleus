# 032 Convergence Local Snap Spawn Receipt Boundary

Status: active
Owner: Tom
Updated: 2026-06-21

## Purpose

Describe sanitized spawn-attempt receipt records for local snap handoffs without
invoking a process runner or retaining raw command output.

## Governing Refs

- `docs/roadmaps/g03/031-convergence-local-snap-spawn-handoff-boundary.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [ ] Create stopped spawn receipt records only from ready local snap handoff
  records.
- [ ] Preserve handoff, spawn request, preflight, replay, evidence, task, repo,
  authority, and idempotency refs.
- [ ] Add read-only diagnostics for accepted, blocked, duplicate, unsupported,
  failed, and cleanup-required receipt states.
- [ ] Keep process runner invocation, actual `converge snap`, raw stdout/stderr,
  object upload, publication, lane sync, provider writes, and task mutation
  false.

## Execution Plan

- [ ] Spawn receipt records batch.
- [ ] Spawn receipt diagnostics batch.
- [ ] Closeout batch.

## Batch Cards

Ready cards:

- `batch-cards/109-convergence-local-snap-spawn-receipt-records.md`

Planned cards:

- `batch-cards/110-convergence-local-snap-spawn-receipt-diagnostics.md`
- `batch-cards/111-convergence-local-snap-spawn-receipt-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Ready handoff records can produce stopped receipt records.
- [ ] Blocked, duplicate, and unsupported handoff records remain inspectable but
  cannot produce accepted receipts.
- [ ] Duplicate receipt ids are deterministic no-ops.
- [ ] No command spawn, actual `converge snap`, raw stdout/stderr, object
  upload, publication, lane sync, provider write, task mutation, callback,
  interruption, recovery, or raw output effect is added.
