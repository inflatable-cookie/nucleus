# 543 Planning Import Active Apply Admission Boundary

Status: ready
Owner: Tom
Updated: 2026-07-03
Milestone: `../124-planning-import-active-apply-admission.md`

## Purpose

Define the authority boundary for active planning import apply admission.

## Work

- [ ] Identify which stopped apply records are eligible for active-apply
  admission.
- [ ] Define required operator approval refs and revision expectations.
- [ ] Define blockers for conflict, stale revision, missing ref, unsupported
  kind, repair-required state, raw payload presence, and effect widening.
- [ ] Keep actual active planning mutation and executor behavior out of scope.

## Acceptance Criteria

- [ ] The selected boundary is explicit enough to implement without guessing.
- [ ] Admission does not grant mutation execution.
- [ ] The next model card can proceed without reopening UI, provider, SCM,
  accepted memory, or research execution authority.
