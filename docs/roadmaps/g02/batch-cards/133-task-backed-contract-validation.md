# 133 Task Backed Contract Validation

Status: planned
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

- Contract reset cards are complete or rehomed.
- Source-model implementation has enough rules to proceed.
- No runtime execution has started.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if any lifecycle rule is still ambiguous.
