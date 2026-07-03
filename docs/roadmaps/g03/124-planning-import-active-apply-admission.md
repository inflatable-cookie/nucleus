# 124 Planning Import Active Apply Admission

Status: ready
Owner: Tom
Updated: 2026-07-03

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

- [ ] Select the active-apply admission boundary over stopped apply records.
- [ ] Require explicit operator approval and revision expectations.
- [ ] Preserve conflict, stale revision, missing ref, unsupported kind, and
  repair-required blockers.
- [ ] Persist active-apply admission records without applying them.
- [ ] Expose read-only diagnostics through server query/control, `nucleusd`,
  and Effigy before any mutation executor.
- [ ] Keep actual planning record mutation, task creation, task promotion,
  projection writes, SCM/forge mutation, provider execution, semantic merge
  automation, accepted memory mutation, and UI behavior out of scope.

## Execution Plan

- [ ] Batch 1: define active-apply admission authority, inputs, stop
  conditions, and deferred effects.
- [ ] Batch 2: model active-apply admission records from stopped apply
  diagnostics and operator approval refs.
- [ ] Batch 3: persist active-apply admission records with duplicate no-op and
  no-effect flags.
- [ ] Batch 4: expose active-apply admission diagnostics query/control/CLI/Effigy.
- [ ] Batch 5: validate and choose whether to build a stopped apply executor,
  desktop review controls, accepted memory authority, or research execution
  planning.

## Batch Cards

Ready cards:

- `batch-cards/543-planning-import-active-apply-admission-boundary.md`

Planned cards:

- `batch-cards/544-planning-import-active-apply-admission-model.md`
- `batch-cards/545-planning-import-active-apply-admission-persistence.md`
- `batch-cards/546-planning-import-active-apply-diagnostics-query-cli-effigy.md`
- `batch-cards/547-planning-import-active-apply-validation-next-lane.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Active-apply admission records are distinct from stopped apply plans and
  from any future apply execution receipts.
- [ ] Admission requires an explicit operator approval ref.
- [ ] Admission preserves revision expectations and sanitized evidence refs.
- [ ] Blocked, stale, conflict, unsupported, repair-required, missing-ref, and
  raw-payload cases do not receive apply authority.
- [ ] Diagnostics expose counts and no-effect flags without raw projected file
  payloads or private planning bodies.
- [ ] No active planning mutation, task creation, task promotion, provider
  execution, agent scheduling, SCM/forge mutation, semantic merge automation,
  accepted memory mutation, or UI behavior is added.

## Stop Conditions

- The work requires actually mutating active planning records.
- The work requires automatic semantic merge resolution.
- The work requires creating active tasks or promoting task seeds.
- The work requires SCM, forge, provider, callback, interruption, or recovery
  effects.
- The work requires raw payload retention or final UI behavior.
