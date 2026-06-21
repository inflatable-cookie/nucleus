# 027 Convergence Local Snap Stopped Runner Command Adapter

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Define a stopped command-adapter boundary over persisted Convergence local snap
runner evidence without invoking `converge snap`.

## Governing Refs

- `docs/roadmaps/g03/026-convergence-local-snap-runner-evidence-persistence.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [x] Describe stopped local snap command-adapter records over persisted
  evidence.
- [x] Preserve idempotency, request, admission, replay, task, repo, and
  authority refs.
- [x] Add diagnostics for runnable, blocked, duplicate, and unsupported states.
- [x] Keep command execution and remote effects false.

## Execution Plan

- [x] Stopped command-adapter batch.
- [x] Diagnostics batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/094-convergence-local-snap-stopped-runner-command-adapter.md`
- `batch-cards/095-convergence-local-snap-stopped-runner-command-diagnostics.md`
- `batch-cards/096-convergence-local-snap-stopped-runner-command-closeout.md`

## Acceptance Criteria

- [x] Reviewable persisted evidence can produce stopped local snap adapter
  records.
- [x] Blocked or duplicate evidence persistence cannot produce runnable
  adapter records.
- [x] The adapter remains a stopped proof, not command execution.
- [x] No command spawn, actual `converge snap`, object upload, publication,
  lane sync, bundle, approval, promotion, release, resolution publication,
  provider write, task mutation, callback, interruption, recovery, or raw
  output effect is added.
