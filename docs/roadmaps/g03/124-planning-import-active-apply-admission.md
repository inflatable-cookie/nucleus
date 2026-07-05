# 124 Planning Import Active Apply Admission

Status: completed
Owner: Tom
Updated: 2026-07-04

## Purpose

Add an explicit active-apply admission gate for planning projection imports.

Roadmap `123` proved the preparation chain: reviewed admissions become
apply-readiness entries, dry-run apply plans, stopped persisted apply records,
and read-only diagnostics. This lane decides which stopped apply records may be
admitted for a later active planning mutation runner.

This roadmap still does not mutate active planning records. It creates
admission records and diagnostics only. The actual apply executor, semantic
merge resolution, task creation, task promotion, projection writes, SCM/forge
mutation, provider execution, accepted memory mutation, and final UI behavior
remain separate authority lanes.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/planning-management-projection-shape.md`
- `docs/architecture/planning-task-seed-gap-matrix.md`
- `docs/roadmaps/g03/123-planning-projection-import-review-apply.md`

## Goals

- [x] Select the active-apply admission boundary over stopped apply records.
- [x] Require explicit operator approval and revision expectations.
- [x] Preserve conflict, stale revision, missing ref, unsupported kind, and
  repair-required blockers.
- [x] Persist active-apply admission records without applying them.
- [x] Expose read-only diagnostics through server query/control, `nucleusd`,
  and Effigy before any mutation executor.
- [x] Keep actual planning record mutation, task creation, task promotion,
  projection writes, SCM/forge mutation, provider execution, semantic merge
  automation, accepted memory mutation, and UI behavior out of scope.

## Execution Plan

- [x] Batch 1: define active-apply admission authority, inputs, stop
  conditions, and deferred effects.
- [x] Batch 2: model active-apply admission records from stopped apply
  diagnostics and operator approval refs.
- [x] Batch 3: persist active-apply admission records with duplicate no-op and
  no-effect flags.
- [x] Batch 4: expose active-apply admission diagnostics query/control/CLI/Effigy.
- [x] Batch 5: validate and choose whether to build a stopped apply executor,
  desktop review controls, accepted memory authority, or research execution
  planning.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/547-planning-import-active-apply-validation-next-lane.md`
- `batch-cards/546-planning-import-active-apply-diagnostics-query-cli-effigy.md`
- `batch-cards/545-planning-import-active-apply-admission-persistence.md`
- `batch-cards/544-planning-import-active-apply-admission-model.md`
- `batch-cards/543-planning-import-active-apply-admission-boundary.md`

## Boundary Decision

Active-apply admission is a stopped planning authority record over a persisted
stopped apply plan. It does not apply the plan. It decides whether a later
executor may be built for that record.

Eligible inputs:

- a persisted stopped apply record from roadmap `123`
- stopped apply status `Persisted`
- at least one planned operation
- zero blocked operations
- zero raw payload or payload-body flags
- no effect-permission flags on the stopped apply record
- operation record ids and file refs present for every planned operation
- expected current revision present for every planned operation that updates an
  existing planning target
- observed revision matching the expected revision when both are present
- sanitized evidence refs for the stopped apply record and operations
- explicit operator approval ref for this admission step

Required refs:

- stopped apply record id
- dry-run plan id
- approval ref
- operator ref
- revision expectation refs per operation
- sanitized evidence refs
- admission request id for duplicate detection

Blocked cases:

- stopped apply record is missing, blocked, or duplicate no-op
- no planned operations exist
- any blocked operation exists
- any operation is inspect-only or unsupported
- missing record id, file ref, evidence ref, or required revision expectation
- stale revision evidence
- conflict, repair-required, unsupported, or missing-ref blocker evidence
- raw projected payload, private planning body, provider payload, source body,
  terminal stream, credential, or secret material is present
- active planning mutation, task creation, task promotion, projection write,
  SCM/forge mutation, provider execution, agent scheduling, semantic merge,
  accepted memory mutation, callback, interruption, recovery, or UI apply is
  requested

Deferred effects:

- active planning record mutation
- apply executor invocation
- semantic merge resolution
- task creation or task seed promotion
- projection file writes
- SCM, forge, provider, callback, interruption, or recovery effects
- accepted memory mutation
- desktop review controls or final UI behavior

The next model card should implement admission request/record/status/blocker
types only. A successful admission may set `apply_admitted = true` on the
admission record, but it must not mutate active planning records or call an
executor.

## Acceptance Criteria

- [x] Active-apply admission records are distinct from stopped apply plans and
  from any future apply execution receipts.
- [x] Admission requires an explicit operator approval ref.
- [x] Admission preserves revision expectations and sanitized evidence refs.
- [x] Blocked, stale, conflict, unsupported, repair-required, missing-ref, and
  raw-payload cases do not receive apply authority.
- [x] Diagnostics expose counts and no-effect flags without raw projected file
  payloads or private planning bodies.
- [x] No active planning mutation, task creation, task promotion, provider
  execution, agent scheduling, SCM/forge mutation, semantic merge automation,
  accepted memory mutation, or UI behavior is added.

## Stop Conditions

- The work requires actually mutating active planning records.
- The work requires automatic semantic merge resolution.
- The work requires creating active tasks or promoting task seeds.
- The work requires SCM, forge, provider, callback, interruption, or recovery
  effects.
- The work requires raw payload retention or final UI behavior.
