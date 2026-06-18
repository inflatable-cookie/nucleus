# 022 SCM Working Session Runtime

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Advance SCM working sessions from neutral planning records toward command
admission and runtime evidence.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/018-orchestration-contract.md`

## Goals

- [x] Add SCM working-session command requests.
- [x] Add provider-neutral command admission for status, session prep, and
  cleanup planning.
- [x] Keep Git-specific worktree/branch mutation behind adapter capability
  gates.
- [x] Preserve Convergence-style snapshot/publication vocabulary.

## Execution Plan

- [x] Session command model batch: name prepare, inspect, integrate, and
  cleanup command requests.
- [x] Git adapter admission batch: map Git branch/worktree possibilities
  without executing mutation.
- [x] Non-Git vocabulary batch: verify snapshot/publication/gate surfaces
  remain first-class.
- [x] Work-item linkage batch: tie session commands to task work items,
  checkpoints, diffs, and receipts.
- [x] Validation batch: prove command records do not assume commit/push
  semantics.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/089-scm-session-command-records.md`
- `batch-cards/090-git-session-admission-records.md`
- `batch-cards/091-non-git-session-vocabulary-validation.md`
- `batch-cards/092-scm-session-work-item-linkage.md`
- `batch-cards/093-scm-session-runtime-validation.md`

## Acceptance Criteria

- [x] SCM session commands remain provider-neutral.
- [x] Git branch/worktree language is adapter-specific.
- [x] Non-Git snapshot/publication/gate flows remain representable.
- [x] Task work items can cite session command evidence by reference.

## Gate

Do not mutate real working copies until host command policy and rollback
behavior are explicit.
