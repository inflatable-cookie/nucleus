# 051 Git Commit Runner Proof

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Implement the first explicit Git commit runner proof from existing admitted
commit preflight records.

This lane may plan and persist commit creation only. It must not push refs,
open pull requests, call forge APIs, run provider writes, answer callbacks,
interrupt/recover harness sessions, mutate task state, retain raw output, or
expand UI/remote transport.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/005-git-commit-admission.md`
- `docs/roadmaps/g03/050-git-branch-worktree-runner-proof.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add commit runner authority from existing ready preflight records.
- [x] Add a constrained commit command adapter.
- [x] Persist sanitized commit runner outcomes and evidence.
- [x] Expose read-only diagnostics/control DTOs for commit runner state.
- [x] Keep warning-sized files split when touched.

## Execution Plan

- [x] Commit runner authority records.
- [x] Commit command adapter.
- [x] Sanitized outcome persistence.
- [x] Diagnostics/control integration.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/168-git-commit-runner-authority-records.md`
- `batch-cards/169-git-commit-runner-command-adapter.md`
- `batch-cards/170-git-commit-runner-outcome-persistence.md`
- `batch-cards/171-git-commit-runner-diagnostics-control.md`
- `batch-cards/172-git-commit-runner-validation-closeout.md`

## Acceptance Criteria

- [x] Runner execution is admitted only from existing ready preflight records
  and explicit operator commit intent.
- [x] Commit message material is referenced by sanitized ref only, not stored
  as raw text.
- [x] Command adapter builds executable argv without shell passthrough.
- [x] Outcomes retain sanitized ids, statuses, counts, path refs by policy, and
  evidence refs only.
- [x] Push, PR, forge, provider, callback, interruption, recovery, task
  mutation, UI/remote transport expansion, and raw-output retention remain
  blocked.
- [x] `effigy doctor` remains error-free or a blocker is recorded.

## Closeout

The commit runner proof now reaches sanitized persistence and read-only control
DTOs from existing admitted commit preflight records.

Next lane:

- compile the Git push runner proof

Reason:

- commit creation now has authority, command adapter, outcome persistence, and
  diagnostics
- push authority is already separated in the Git change-request sequence
- PR execution should remain behind persisted push outcome evidence
