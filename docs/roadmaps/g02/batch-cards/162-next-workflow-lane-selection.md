# 162 Next Workflow Lane Selection

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../036-task-backed-workflow-validation-and-next-lane.md`

## Purpose

Choose the next workflow after task-backed agent work.

## Scope

- Compare repo-backed management sync and native steward.
- Use evidence from the task-backed proof.
- Do not open parallel lanes.

## Acceptance Criteria

- Next workflow recommendation is explicit.
- Operator decision needs are visible.
- No speculative cards are created without a chosen lane.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if the choice is product-directional.
