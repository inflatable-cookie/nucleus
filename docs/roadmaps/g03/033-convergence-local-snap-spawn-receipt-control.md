# 033 Convergence Local Snap Spawn Receipt Control

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Expose stopped local snap spawn receipts through a read-only control shape
without granting process-runner, command, raw-output, provider, or task
mutation authority.

## Governing Refs

- `docs/roadmaps/g03/032-convergence-local-snap-spawn-receipt-boundary.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [x] Add read-only control DTO records over sanitized spawn receipt records.
- [x] Preserve receipt, handoff, spawn request, preflight, replay, task, repo,
  authority, and idempotency refs.
- [x] Report accepted, blocked, duplicate, unsupported, failed, and
  cleanup-required counts.
- [x] Keep process runner invocation, actual `converge snap`, raw stdout/stderr,
  provider writes, and task mutation false.

## Execution Plan

- [x] Control DTO batch.
- [x] Control diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/112-convergence-local-snap-spawn-receipt-control-dto.md`
- `batch-cards/113-convergence-local-snap-spawn-receipt-control-diagnostics.md`
- `batch-cards/114-convergence-local-snap-spawn-receipt-control-closeout.md`

## Acceptance Criteria

- [x] Receipt control DTOs summarize sanitized receipt records.
- [x] DTOs expose counts and ids without raw process material.
- [x] DTOs grant no process runner, command spawn, provider write, or task
  mutation authority.
- [x] No command spawn, actual `converge snap`, raw stdout/stderr, object
  upload, publication, lane sync, provider write, task mutation, callback,
  interruption, recovery, or raw output effect is added.
