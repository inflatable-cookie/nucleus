# 081 Selected Task Delegation Work Item Admission

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../017-selected-task-delegation-scheduling-admission.md`

## Purpose

Add the pure server model for selected-task delegation scheduling admission.

## Work

- [ ] Compose admission input/output types for selected-task delegation.
- [ ] Validate task/project refs, expected revision, operator ref,
  idempotency key, readiness refs, route/rework source refs, and conflicting
  work-item blockers.
- [ ] Return admitted/refused status, candidate work-item refs, source refs,
  refusal reasons, and no-effect flags.
- [ ] Add focused model tests.

## Acceptance Criteria

- [ ] Admitted output can describe a scheduled work-item candidate without
  starting provider execution.
- [ ] Refusals fail closed and preserve clear reasons.
- [ ] Tests cover missing refs, stale revision, missing operator/idempotency,
  unsupported route, conflicting active work, and no-effect guarantees.
