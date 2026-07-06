# 017 Selected Task Work Loop Guidance Read Model

Status: planned
Owner: Tom
Updated: 2026-07-06
Milestone: `../004-selected-task-work-loop-composition.md`

## Purpose

Add the smallest read-only guidance shape needed for the selected-task loop.

## Work

- [ ] Decide whether guidance belongs in the existing task workflow drilldown
  DTO or a separate read-only query.
- [ ] Represent safe next action, missing evidence, and blocked reason without
  creating commands.
- [ ] Add focused tests for no effects, identity filtering, and sanitized refs.
- [ ] Keep task mutation, provider execution, SCM mutation, and active apply out
  of scope.

## Acceptance Criteria

- [ ] The selected-task workflow can explain the safe next action.
- [ ] Guidance is server-owned and read-only.
- [ ] The proof does not duplicate product workflow summary logic blindly.
