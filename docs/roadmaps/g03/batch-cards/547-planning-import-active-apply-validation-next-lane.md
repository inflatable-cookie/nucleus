# 547 Planning Import Active Apply Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-04
Milestone: `../124-planning-import-active-apply-admission.md`

## Purpose

Validate active-apply admission and choose the next lane.

## Work

- [x] Run focused planning/server/CLI tests.
- [x] Run docs QA, Northstar QA, diff check, and doctor.
- [x] Decide whether to move next to a stopped apply executor, desktop review
  controls, accepted memory authority, or research execution planning.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] Doctor has zero errors.
- [x] The next lane follows evidence and does not create task, provider, SCM,
  forge, accepted memory, active planning mutation, or UI authority by accident.

## Decision

Move next to a planning import active-apply executor boundary lane.

The lane should first define executor authority, receipts, revision checks, and
rollback/repair stop conditions over persisted active-apply admissions. It must
not jump directly into desktop review controls, accepted memory authority,
research execution planning, task creation, provider execution, SCM/forge
mutation, semantic merge automation, or broad UI behavior.
