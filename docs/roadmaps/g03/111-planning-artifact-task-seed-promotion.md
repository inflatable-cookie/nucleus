# 111 Planning Artifact Task Seed Promotion

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Create the first server-owned path from structured planning output to
reviewable task seeds.

This lane should not silently create active tasks. It should model planning
artifacts and task seeds as reviewable records first, then expose read-only
inspection before any promotion command is admitted.

## Governing Refs

- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/015-deep-research-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/task-project-workflow-gap-matrix.md`
- `docs/architecture/planning-task-seed-gap-matrix.md`

## Goals

- [x] Audit existing planning, task seed, task command, and projection surfaces.
- [x] Define first planning artifact and task seed record shapes.
- [x] Keep task seeds separate from active tasks.
- [x] Add read-only task seed candidate projection before promotion.
- [x] Defer promotion commands until record shapes and review semantics are
  validated.

## Execution Plan

- [x] Batch 1: audit current planning and task seed implementation against
  contracts.
- [x] Batch 2: define implementation gap matrix and selected first slice.
- [x] Batch 3: implement planning artifact/task seed record types if contract
  coverage is sufficient.
- [x] Batch 4: expose read-only task seed inspection through server query,
  control DTO, `nucleusd`, and Effigy.
- [x] Batch 5: validate and select whether the next lane is task seed
  promotion command, planning artifact projection, or task readiness linkage.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/451-planning-task-seed-surface-audit.md`
- `batch-cards/452-planning-task-seed-gap-matrix.md`
- `batch-cards/453-planning-task-seed-record-selection.md`
- `batch-cards/454-planning-task-seed-record-implementation.md`
- `batch-cards/455-planning-task-seed-query-control-cli-effigy.md`
- `batch-cards/456-planning-task-seed-validation.md`
- `batch-cards/457-planning-task-seed-next-lane-checkpoint.md`
- `batch-cards/458-planning-task-seed-closeout.md`

## Acceptance Criteria

- [x] Task seeds remain reviewable planning output, not active tasks.
- [x] Planning artifact refs are explicit and sanitized.
- [x] No active task is created without an admitted task-domain command.
- [x] Read-only inspection exists before any promotion command.
- [x] No provider execution, SCM/forge mutation, scoring policy, autonomous
  goal loops, or UI-triggered mutation is added.

## Stop Conditions

- Contract coverage is insufficient for planning artifact or task seed records.
- Implementation would silently promote seeds into active tasks.
- Implementation requires final UI design.
- Implementation requires provider execution, SCM/forge mutation, scoring
  policy, or autonomous goal loops.
