# 050 Git Branch Worktree Runner Proof

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Implement the first explicit Git branch/worktree runner proof from the existing
stopped-by-default handoff records.

This lane may plan and implement branch/worktree setup only. It must not create
commits, push refs, open pull requests, call forge APIs, run provider writes,
answer callbacks, interrupt/recover harness sessions, mutate task state, retain
raw output, or expand UI/remote transport.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/003-git-branch-worktree-admission.md`
- `docs/roadmaps/g03/004-git-branch-worktree-execution-handoff.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Refresh authority boundaries for real branch/worktree execution.
- [x] Add a constrained runner command adapter from existing handoff records.
- [x] Persist sanitized runner outcomes and evidence.
- [x] Expose read-only diagnostics/control DTOs for runner state.
- [x] Keep warning-sized files split when touched.

## Execution Plan

- [x] Authority and existing-record refresh.
- [x] Runner command adapter.
- [x] Sanitized outcome persistence.
- [x] Diagnostics/control integration.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/163-git-branch-worktree-runner-authority-refresh.md`
- `batch-cards/164-git-branch-worktree-runner-command-adapter.md`
- `batch-cards/165-git-branch-worktree-runner-outcome-persistence.md`
- `batch-cards/166-git-branch-worktree-runner-diagnostics-control.md`
- `batch-cards/167-git-branch-worktree-runner-validation-closeout.md`

## Acceptance Criteria

- [x] Runner execution is admitted only from existing ready handoff records and
  explicit operator effect intent.
- [x] Primary-tree and isolated-worktree modes remain distinct.
- [x] Outcomes retain sanitized ids, statuses, counts, paths by policy, and
  evidence refs only.
- [x] Raw stdout/stderr, provider writes, commit/push/PR/forge effects,
  callbacks, interruption, recovery, task mutation, and UI/remote transport
  expansion remain blocked.
- [x] `effigy doctor` remains error-free or a blocker is recorded.

## Closeout

The runner proof now reaches sanitized persistence and read-only control DTOs
from existing admitted branch/worktree handoffs.

Next lane:

- compile the Git commit runner proof

Reason:

- branch/worktree setup is now the first effect with authority, command adapter,
  outcome persistence, and diagnostics
- commit authority is already separated in the Git change-request sequence
- push and PR execution should stay behind commit outcome evidence
