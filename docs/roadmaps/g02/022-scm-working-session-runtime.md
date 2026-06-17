# 022 SCM Working Session Runtime

Status: planned
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

- [ ] Add SCM working-session command requests.
- [ ] Add provider-neutral command admission for status, session prep, and
  cleanup planning.
- [ ] Keep Git-specific worktree/branch mutation behind adapter capability
  gates.
- [ ] Preserve Convergence-style snapshot/publication vocabulary.

## Execution Plan

- [ ] Session command model batch: name prepare, inspect, integrate, and
  cleanup command requests.
- [ ] Git adapter admission batch: map Git branch/worktree possibilities
  without executing mutation.
- [ ] Non-Git vocabulary batch: verify snapshot/publication/gate surfaces
  remain first-class.
- [ ] Work-item linkage batch: tie session commands to task work items,
  checkpoints, diffs, and receipts.
- [ ] Validation batch: prove command records do not assume commit/push
  semantics.

## Batch Cards

Planned cards:

- `batch-cards/089-scm-session-command-records.md`
- `batch-cards/090-git-session-admission-records.md`
- `batch-cards/091-non-git-session-vocabulary-validation.md`
- `batch-cards/092-scm-session-work-item-linkage.md`
- `batch-cards/093-scm-session-runtime-validation.md`

## Acceptance Criteria

- [ ] SCM session commands remain provider-neutral.
- [ ] Git branch/worktree language is adapter-specific.
- [ ] Non-Git snapshot/publication/gate flows remain representable.
- [ ] Task work items can cite session command evidence by reference.

## Gate

Do not mutate real working copies until host command policy and rollback
behavior are explicit.
