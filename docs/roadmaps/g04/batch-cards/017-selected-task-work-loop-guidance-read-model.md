# 017 Selected Task Work Loop Guidance Read Model

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../004-selected-task-work-loop-composition.md`

## Purpose

Add the smallest read-only guidance shape needed for the selected-task loop.

## Work

- [x] Add guidance to the existing task workflow drilldown DTO unless the
  implementation proves this overloads the query.
- [x] Represent guidance source, safe action label, reason, evidence refs,
  missing evidence areas, and blocked reason without creating commands.
- [x] Add focused tests for no effects, identity filtering, and sanitized refs.
- [x] Keep task mutation, provider execution, SCM mutation, and active apply out
  of scope.

## Acceptance Criteria

- [x] The selected-task workflow can explain the safe next action.
- [x] Guidance is server-owned and read-only.
- [x] The proof does not duplicate product workflow summary logic blindly.

## Implementation Notes

Use the decision order in
`../004-selected-task-work-loop-composition.md#work-loop-decision-order`.

The minimum shape is read-only guidance over existing drilldown sources. Do not
add command admission, provider execution, SCM mutation, active memory apply,
planning active apply, or final UI behavior.

## Result

The existing task workflow drilldown now includes read-only guidance:

- source
- safe action
- reason
- evidence refs
- missing evidence areas
- blocked reason

The guidance is built from existing selected-task sources and retains the
drilldown no-effect boundary. It does not add a new query, command admission,
provider execution, SCM mutation, active apply, or UI authority.
