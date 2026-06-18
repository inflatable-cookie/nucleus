# 132 Task Work Review Acceptance Contract

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../030-task-backed-agent-workflow-contract-reset.md`

## Purpose

Define review and acceptance boundaries for task-backed work.

## Scope

- Name review, accept, reject, and rework states.
- Connect checkpoints and diff summaries to review.
- Keep SCM mutation out of the review contract.

## Acceptance Criteria

- [x] Work can finish in review without silently completing the task.
- [x] Accepted work and task completion remain distinct.
- [x] Rework preserves provenance.

## Result

`023-task-backed-agent-workflow-contract.md` defines review entry evidence,
operator decision fields, rejection/change/abandon reasons, and rework
provenance. Review acceptance still does not complete the parent task.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if review rules need real SCM mutation.
