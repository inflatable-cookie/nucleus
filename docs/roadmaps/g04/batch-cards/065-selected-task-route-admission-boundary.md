# 065 Selected Task Route Admission Boundary

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../014-selected-task-route-admission.md`

## Purpose

Define how selected-task review outcome routes enter explicit task admission
flows.

## Work

- [ ] Document route-admission source refs and authority boundaries.
- [ ] Define accepted-review completion admission stop conditions.
- [ ] Define rework, delegation, SCM handoff review, and abandoned-review
  non-implementation boundaries.
- [ ] Identify where existing task command admission can be reused and where a
  new admission shape is needed.

## Acceptance Criteria

- [ ] The route-admission lane cannot mutate task lifecycle state.
- [ ] Completion admission is clearly separated from completion apply.
- [ ] Rework and delegation are scoped as preview/readiness only.
- [ ] Next implementation card has enough contract detail to write tests first.
