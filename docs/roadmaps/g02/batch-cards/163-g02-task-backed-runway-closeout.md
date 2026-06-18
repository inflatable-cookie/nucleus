# 163 G02 Task Backed Runway Closeout

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../036-task-backed-workflow-validation-and-next-lane.md`

## Purpose

Close the task-backed workflow runway and set the next roadmap pointer.

## Scope

- Update generation, roadmap, and batch-card indexes.
- Record validation state.
- Set the next ready card or paused operator gate.

## Acceptance Criteria

- Roadmap pointer is explicit.
- Completed cards are indexed.
- No stale ready cards remain.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if closeout needs a new generation decision.
