# 133 Task Backed Contract Validation

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../030-task-backed-agent-workflow-contract-reset.md`

## Purpose

Validate task-backed workflow contracts and advance to source records.

## Scope

- Run docs gates.
- Update indexes.
- Move the ready pointer to source-model implementation.

## Acceptance Criteria

- [x] Contract reset cards are complete or rehomed.
- [x] Source-model implementation has enough rules to proceed.
- [x] No runtime execution has started.

## Result

The contract reset is complete. The next ready card is
`134-task-work-unit-source-records.md`.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if any lifecycle rule is still ambiguous.
