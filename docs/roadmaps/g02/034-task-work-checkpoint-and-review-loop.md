# 034 Task Work Checkpoint And Review Loop

Status: planned
Owner: Tom
Updated: 2026-06-18

## Purpose

Add reviewable completion boundaries for task-backed work units.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/roadmaps/g02/006-checkpoint-and-diff-foundation.md`

## Goals

- [ ] Attach checkpoint refs to task work-unit outcomes.
- [ ] Attach diff summary refs without mutating SCM state.
- [ ] Add review and acceptance commands for work-unit completion.
- [ ] Project review state into task timeline/read models.

## Execution Plan

- [ ] Checkpoint batch: connect checkpoint refs to work-unit outcomes.
- [ ] Diff batch: connect diff summaries to review state.
- [ ] Review command batch: add accept/reject/rework command shapes.
- [ ] Timeline batch: project review state into task history.
- [ ] Validation batch: prove no SCM mutation.

## Batch Cards

Planned cards:

- `batch-cards/149-task-work-checkpoint-linkage.md`
- `batch-cards/150-task-work-diff-summary-linkage.md`
- `batch-cards/151-task-work-review-command-shapes.md`
- `batch-cards/152-task-work-review-timeline-projection.md`
- `batch-cards/153-task-work-review-validation.md`

## Acceptance Criteria

- [ ] A work unit can end in review rather than silent completion.
- [ ] Acceptance/rework state is auditable.
- [ ] SCM mutation remains outside this milestone.

## Gate

Do not implement branch, worktree, commit, push, or PR mutation here.
