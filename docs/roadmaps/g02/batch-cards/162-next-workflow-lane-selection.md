# 162 Next Workflow Lane Selection

Status: completed
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

## Result

- Selected repo-backed management sync hardening as the next workflow lane.
- Reason: task-backed work now has a proof path, but shared project/task state
  still needs committable projection discipline before steward automation,
  richer UI work, or more provider runtime work should expand.
- Native steward remains the likely follow-on after projection authority is
  stronger.
