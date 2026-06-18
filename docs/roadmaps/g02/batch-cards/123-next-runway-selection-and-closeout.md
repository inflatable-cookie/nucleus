# 123 Next Runway Selection And Closeout

Status: completed
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

- [x] Next roadmap pointer is explicit.
- [x] No parallel speculative lanes remain active.
- [x] Operator decision needs are clear if paused.

## Outcome

G02 is paused at workflow selection. The roadmap front door asks Tom to choose
the next workflow runway before new implementation cards are created.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if the workflow choice is product-directional.
