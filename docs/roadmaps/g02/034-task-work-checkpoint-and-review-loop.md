# 034 Task Work Checkpoint And Review Loop

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Add reviewable completion boundaries for task-backed work units.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/roadmaps/g02/006-checkpoint-and-diff-foundation.md`

## Goals

- [x] Attach checkpoint refs to task work-unit outcomes.
- [x] Attach diff summary refs without mutating SCM state.
- [x] Add review and acceptance commands for work-unit completion.
- [x] Project review state into task timeline/read models.

## Execution Plan

- [x] Checkpoint batch: connect checkpoint refs to work-unit outcomes.
- [x] Diff batch: connect diff summaries to review state.
- [x] Review command batch: add accept/reject/rework command shapes.
- [x] Timeline batch: project review state into task history.
- [x] Validation batch: prove no SCM mutation.

## Batch Cards

Completed cards:

- `batch-cards/149-task-work-checkpoint-linkage.md`
- `batch-cards/150-task-work-diff-summary-linkage.md`
- `batch-cards/151-task-work-review-command-shapes.md`
- `batch-cards/152-task-work-review-timeline-projection.md`
- `batch-cards/153-task-work-review-validation.md`

## Acceptance Criteria

- [x] A work unit can end in review rather than silent completion.
- [x] Acceptance/rework state is auditable.
- [x] SCM mutation remains outside this milestone.

## Result

Review decisions now carry validation, checkpoint, and diff evidence; review
commands guard expected state; timeline entries are deterministic; SCM mutation
is not part of the loop.

## Gate

Do not implement branch, worktree, commit, push, or PR mutation here.
