# 543 Planning Import Active Apply Admission Boundary

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../124-planning-import-active-apply-admission.md`

## Purpose

Define the authority boundary for active planning import apply admission.

## Work

- [x] Identify which stopped apply records are eligible for active-apply
  admission.
- [x] Define required operator approval refs and revision expectations.
- [x] Define blockers for conflict, stale revision, missing ref, unsupported
  kind, repair-required state, raw payload presence, and effect widening.
- [x] Keep actual active planning mutation and executor behavior out of scope.

## Decision

Active-apply admission is a stopped authority record over a persisted stopped
apply record. It requires explicit operator approval, stable stopped apply refs,
sanitized evidence refs, and current revision expectations. It does not apply
the record.

Eligible stopped apply records:

- status is `Persisted`
- at least one planned operation exists
- no blocked operations exist
- no raw payload or payload-body flags are set
- no active planning, task, projection, SCM, forge, provider, semantic merge,
  accepted memory, agent scheduling, callback, interruption, recovery, or UI
  effect is requested or permitted
- planned operations have record ids, file refs, evidence refs, and required
  revision expectations

Required approval inputs:

- admission request id
- stopped apply record id
- dry-run plan id
- operator ref
- approval ref
- revision expectation refs for every planned operation that updates an
  existing target
- sanitized evidence refs

Admission blockers:

- stopped apply record missing, blocked, or duplicate no-op
- missing approval, operator, stopped apply, dry-run plan, operation, record,
  file, evidence, or revision refs
- conflict, stale revision, unsupported kind, missing ref, inspect-only
  operation, or repair-required evidence
- raw projected payload, private planning body, provider payload, source body,
  terminal stream, credential, or secret material present
- any active planning mutation or executor behavior requested
- task creation, task promotion, projection write, SCM/forge mutation,
  provider execution, agent scheduling, semantic merge automation, accepted
  memory mutation, callback, interruption, recovery, or UI behavior requested

## Acceptance Criteria

- [x] The selected boundary is explicit enough to implement without guessing.
- [x] Admission does not grant mutation execution.
- [x] The next model card can proceed without reopening UI, provider, SCM,
  accepted memory, or research execution authority.
