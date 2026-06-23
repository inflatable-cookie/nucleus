# 112 Planning Task Seed Persistence And Projection

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Make planning task seed inspection useful from durable records without adding
promotion commands or silent task creation.

Roadmap `111` proved the record model and read-only control surface. This lane
fills the storage and projection gap so clients can inspect real planning
output before any task-domain mutation path exists.

## Governing Refs

- `docs/contracts/005-task-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/015-deep-research-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/planning-task-seed-gap-matrix.md`
- `docs/roadmaps/g03/111-planning-artifact-task-seed-promotion.md`

## Goals

- [x] Add durable planning artifact and task seed storage shape.
- [x] Read task seed candidates from persisted planning records.
- [x] Add fixture-backed non-empty inspection.
- [x] Define management projection shape without committing promotion policy.
- [x] Reassess whether the next lane is promotion, planning sessions, or task
  readiness linkage.

## Execution Plan

- [x] Batch 1: select the narrow storage/codec shape.
- [x] Batch 2: persist and decode planning task seed records.
- [x] Batch 3: compose the server query from persisted records.
- [x] Batch 4: add fixture-backed non-empty CLI/Effigy proof.
- [x] Batch 5: define management projection shape and deferred merge policy.
- [x] Batch 6: validate and choose the next lane.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/459-planning-task-seed-storage-codec-selection.md`
- `batch-cards/460-planning-task-seed-local-store-records.md`
- `batch-cards/461-planning-task-seed-query-from-persistence.md`
- `batch-cards/462-planning-task-seed-fixture-effigy-smoke.md`
- `batch-cards/463-planning-artifact-management-projection-shape.md`
- `batch-cards/464-planning-task-seed-persistence-validation.md`
- `batch-cards/465-planning-task-seed-promotion-readiness-reassessment.md`
- `batch-cards/466-planning-task-seed-persistence-closeout.md`

## Acceptance Criteria

- [x] Read-only task seed inspection can show persisted seed candidates.
- [x] No active task is created without a task-domain command.
- [x] Promotion remains deferred until persistence and review semantics are
  validated.
- [x] Management projection shape is explicit enough to plan repo-backed
  planning output.
- [x] No provider execution, SCM/forge mutation, scoring policy, autonomous
  goal loops, or UI-triggered mutation is added.

## Stop Conditions

- Codec work would require committing final repo-file merge policy.
- Query work would silently create tasks from planning seeds.
- Management projection work would overfit to Git-only workflows.
