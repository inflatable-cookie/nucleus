# 065 Selected Task Route Admission Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../014-selected-task-route-admission.md`

## Purpose

Define how selected-task review outcome routes enter explicit task admission
flows.

## Work

- [x] Document route-admission source refs and authority boundaries.
- [x] Define accepted-review completion admission stop conditions.
- [x] Define rework, delegation, SCM handoff review, and abandoned-review
  non-implementation boundaries.
- [x] Identify where existing task command admission can be reused and where a
  new admission shape is needed.

## Acceptance Criteria

- [x] The route-admission lane cannot mutate task lifecycle state.
- [x] Completion admission is clearly separated from completion apply.
- [x] Rework and delegation are scoped as preview/readiness only.
- [x] Next implementation card has enough contract detail to write tests first.

## Result

The roadmap now defines the route-admission authority model, allowed source
refs, forbidden sources, accepted-review completion stop conditions, rework and
delegation preview scope, SCM handoff review preview scope, abandoned-review
handling, reuse boundaries for existing selected-task command admission, and
test-first implementation notes.

Completion admission remains a dry-run preview. Completion apply, rework work
item creation, delegation scheduling, SCM/forge mutation, memory/planning
apply, and projection writes remain out of scope.
