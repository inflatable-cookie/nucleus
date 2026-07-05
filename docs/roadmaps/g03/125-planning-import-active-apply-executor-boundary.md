# 125 Planning Import Active Apply Executor Boundary

Status: paused
Owner: Tom
Updated: 2026-07-04

## Purpose

Define the boundary for a future executor that can apply admitted planning
imports to active planning records.

Roadmap `124` proved the admission gate: only persisted active-apply admission
records with explicit approval, revision expectations, sanitized evidence, and
no widened effects can receive apply authority. This lane must not treat that
as permission to build broad automation. It starts by specifying the executor
contract, receipts, stop conditions, and diagnostics before any mutation path is
implemented.

Paused after Batch 2. The boundary and stopped executor model are useful, but
continuing into executor persistence and diagnostics before proving the
end-to-end value would add more planning-import machinery than the product
currently needs.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/architecture/planning-management-projection-shape.md`
- `docs/architecture/planning-task-seed-gap-matrix.md`
- `docs/roadmaps/g03/124-planning-import-active-apply-admission.md`

## Goals

- [x] Define active-apply executor authority separately from admission records.
- [x] Require persisted admission records, operator approval refs, and revision
  expectations before any executor can be planned.
- [x] Model executor receipts without adding task creation, task promotion,
  provider execution, SCM/forge mutation, accepted memory mutation, or UI
  behavior.
- [x] Preserve conflict, stale revision, missing ref, unsupported kind, and
  repair-required stop conditions.
- [ ] Expose read-only diagnostics before any final apply behavior.

## Execution Plan

- [x] Batch 1: define executor authority, admitted inputs, stop conditions,
  deferred effects, and receipt boundaries.
- [x] Batch 2: model executor plan and stopped receipts without mutating active
  planning records.
- [ ] Batch 3: persist executor plan/receipt records with duplicate no-op and
  no-effect flags.
- [ ] Batch 4: expose executor diagnostics query/control/CLI/Effigy.
- [ ] Batch 5: validate and decide whether to implement the actual planning
  mutation runner, desktop review controls, accepted memory authority, or
  research execution planning.

## Batch Cards

Ready cards:

None.

Paused cards:

- `batch-cards/550-planning-import-active-apply-executor-persistence.md`
- `batch-cards/551-planning-import-active-apply-executor-diagnostics-query-cli-effigy.md`
- `batch-cards/552-planning-import-active-apply-executor-validation-next-lane.md`

Planned cards:

None.

Completed cards:

- `batch-cards/549-planning-import-active-apply-executor-plan-model.md`
- `batch-cards/548-planning-import-active-apply-executor-boundary.md`

## Boundary Decision

The next model is stopped executor planning, not a direct mutation runner.

Executor authority is distinct from admission authority:

- admission records decide whether a stopped apply record may be considered for
  execution
- executor plans decide whether a concrete set of planning-record mutations can
  be prepared from an admitted record
- executor receipts prove what a future runner would have attempted or stopped
  on; they are not final active planning mutation receipts

Required inputs:

- persisted active-apply admission record from roadmap `124`
- admission status `AdmittedStopped`
- `apply_admitted = true`
- stopped apply record id and dry-run apply plan id
- operator ref and approval ref
- one or more operation refs
- record id and file ref for every operation
- revision expectation ref for every operation that targets an existing record
- observed revision matching expected revision when both are present
- sanitized evidence refs from admission and operation refs
- executor request id for duplicate detection

Executor authority refs:

- executor request id
- executor plan id
- admitted active-apply record id
- stopped apply record id
- dry-run apply plan id
- operator ref
- approval ref
- revision expectation refs
- sanitized evidence refs
- planned receipt ids for each operation

Stopped cases:

- missing, blocked, duplicate no-op, or non-persisted admission record
- `apply_admitted = false`
- missing stopped apply record id, plan id, operation ref, record id, file ref,
  approval ref, operator ref, evidence ref, or revision expectation
- stale observed revision
- conflict, unsupported kind, missing ref, or repair-required evidence
- raw projected payload, private planning body, provider payload, source body,
  terminal stream, credential, or secret material is present
- active planning mutation is requested before the executor runner lane
- task creation, task promotion, provider execution, SCM/forge mutation,
  semantic merge automation, accepted memory mutation, callback, interruption,
  recovery, or UI behavior is requested

Deferred effects:

- active planning record mutation
- final mutation receipts
- semantic merge resolution
- task creation or task seed promotion
- projection file writes
- SCM, forge, provider, callback, interruption, or recovery effects
- accepted memory mutation
- desktop review controls or final UI behavior

The model card should produce deterministic executor plan/receipt records from
admission records only. A successful stopped executor plan may set
`executor_planned = true`, but it must not mutate active planning records.

## Pause Decision

Do not continue into Batch 3 yet.

The next useful step is a minimum apply proof that exercises the existing
guardrails on one safe planning artifact path. That proof should answer whether
the import/apply workflow is valuable in practice before adding more persisted
executor shells.

## Stop Conditions

- The work requires mutating active planning records before the executor
  boundary is explicit.
- The work requires creating tasks or promoting task seeds.
- The work requires provider execution, SCM/forge mutation, callback,
  interruption, recovery, accepted memory mutation, or UI behavior.
- The work requires retaining raw projected payloads, private planning bodies,
  provider payloads, source bodies, credentials, or terminal streams.

## Acceptance Criteria

- [ ] Executor authority is distinct from admission authority.
- [ ] Executor records preserve approval refs, revision expectations, and
  sanitized evidence refs.
- [ ] Read-only diagnostics exist before any final mutation runner.
- [ ] No unrelated task, provider, SCM/forge, accepted memory, semantic merge,
  or UI authority is added.
