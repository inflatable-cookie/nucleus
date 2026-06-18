# 123 Next Runway Selection And Closeout

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../028-next-product-workflow-selection.md`

## Purpose

Close workflow selection and set the next roadmap pointer.

## Scope

- Choose the next workflow runway if evidence is sufficient.
- Otherwise pause for operator intent.
- Keep only one active implementation lane.

## Acceptance Criteria

- Next roadmap pointer is explicit.
- No parallel speculative lanes remain active.
- Operator decision needs are clear if paused.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if the workflow choice is product-directional.
