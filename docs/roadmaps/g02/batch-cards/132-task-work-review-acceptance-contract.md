# 132 Task Work Review Acceptance Contract

Status: planned
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

- Work can finish in review without silently completing the task.
- Accepted work and task completion remain distinct.
- Rework preserves provenance.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if review rules need real SCM mutation.
