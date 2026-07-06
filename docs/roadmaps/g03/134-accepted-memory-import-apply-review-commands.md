# 134 Accepted Memory Import Apply Review Commands

Status: completed
Owner: Tom
Updated: 2026-07-06

## Purpose

Add explicit review commands for accepted-memory import-apply admissions before
any active accepted-memory mutation executor exists.

Roadmap `133` made accepted-memory import/apply readiness visible as a
read-only product surface. It shows approval-required records, but it still has
no command boundary for an operator or steward to approve, defer, or reject a
stopped apply/admission record.

This lane creates review receipts only. It does not apply accepted memory,
write projection files, share through SCM/forge, run embeddings/search, sync
provider-native memory, extract memories automatically, mutate tasks, schedule
agents, or implement final UI behavior.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/roadmaps/g03/132-accepted-memory-import-apply-admission.md`
- `docs/roadmaps/g03/133-accepted-memory-review-product-consumption-readiness.md`

## Goals

- [x] Define approve, defer, and reject review decisions for stopped
  import-apply admissions.
- [x] Model sanitized review receipts with operator, approval, admission,
  conflict, candidate, file, provenance, and evidence refs.
- [x] Keep review receipts distinct from active apply receipts.
- [x] Expose read-only review diagnostics through server query/control,
  `nucleusd`, and Effigy if the command model holds.
- [x] Keep active accepted-memory mutation, projection writes, SCM/forge
  mutation, embeddings/search/provider sync, automatic extraction, task
  mutation, agent scheduling, and final UI behavior out of scope.

## Execution Plan

- [x] Batch 1: define command boundary, decisions, required refs, blockers,
  no-effect flags, and receipt classes.
- [x] Batch 2: implement review command model and sanitized receipt records.
- [x] Batch 3: expose read-only review diagnostics through server query/control
  and CLI surfaces.
- [x] Batch 4: validate and choose the next bounded lane.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/590-accepted-memory-import-apply-review-validation-next-lane.md`
- `batch-cards/589-accepted-memory-import-apply-review-diagnostics-control.md`
- `batch-cards/588-accepted-memory-import-apply-review-command-model.md`
- `batch-cards/587-accepted-memory-import-apply-review-command-boundary.md`

## Boundary

Review commands may create sanitized review receipts for stopped
apply/admission records:

- approve: records explicit operator approval refs for a later active executor
- defer: records that the admission remains staged and needs later review
- reject: records that the admission must not be applied without a new review

Review receipts are not active apply receipts. They do not mutate
accepted-memory records or change projection/import state.

## Stop Conditions

- The work requires creating, updating, deleting, or superseding accepted-memory
  records.
- The work requires writing projection files.
- The work requires SCM/forge capture, publication, push, PR, merge, or status
  effects.
- The work requires embeddings, search, provider-native memory sync, automatic
  extraction, task mutation, agent scheduling, callback, interruption, recovery,
  raw payload retention, or final UI behavior.

## Acceptance Criteria

- [x] Review decisions and receipts are distinct from active apply execution.
- [x] Approval requires operator and approval refs.
- [x] Deferral and rejection preserve admission, conflict, candidate, file,
  provenance, and evidence refs.
- [x] Blocked, conflicted, duplicate, missing-ref, raw-payload, or
  effect-widened admissions cannot receive unsafe approval.
- [x] No active accepted-memory mutation, projection write, SCM/forge mutation,
  embeddings/search/provider sync, automatic extraction, task mutation, agent
  scheduling, or final UI behavior is added.

## Closeout

Review-command receipts are modeled and exposed through read-only diagnostics.
They are not persisted yet. That distinction is deliberate: the next lane must
make operator review receipts durable before any active accepted-memory apply
executor can exist.

Next selected lane:
`135-accepted-memory-review-receipt-persistence-and-apply-admission.md`.
