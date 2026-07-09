# 080 Selected Task Delegation Scheduling Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../017-selected-task-delegation-scheduling-admission.md`

## Purpose

Define the selected-task delegation scheduling boundary before adding any
work-item admission behavior.

## Work

- [x] Map source records for delegation scheduling admission.
- [x] Define required ids, operator intent, revision guards, and idempotency.
- [x] Define stop conditions for provider execution, SCM/forge mutation,
  projection writes, memory/planning apply, and final UI.
- [x] Identify which existing engine/server records can be reused and which
  gaps stay explicit.

## Acceptance Criteria

- [x] The boundary explains when delegation scheduling can be admitted.
- [x] Provider execution remains out of scope.
- [x] The next card can implement a pure admission model without fresh
  architecture decisions.

## Result

Roadmap 017 now defines the delegation scheduling source map, authority map,
required inputs, refusal matrix, no-effect flags, and work-item creation
posture.

The next model can be implemented as a selected-task delegation scheduling
admission preview without calling providers, invoking harnesses, mutating
SCM/forge state, writing projections, or treating desktop UI as authority.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
