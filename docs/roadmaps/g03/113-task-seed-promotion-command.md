# 113 Task Seed Promotion Command

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Add an explicit command path that can promote a reviewed planning task seed
into an active task.

The previous lane proved persisted, reviewable task seeds and read-only
inspection. This lane must keep promotion explicit, idempotent, review-gated,
and task-domain owned.

## Governing Refs

- `docs/contracts/005-task-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/planning-task-seed-gap-matrix.md`
- `docs/architecture/planning-task-seed-storage-codec-selection.md`
- `docs/architecture/planning-management-projection-shape.md`
- `docs/roadmaps/g03/112-planning-task-seed-persistence-and-projection.md`

## Goals

- [x] Define promotion admission rules.
- [x] Add a task-domain command that creates a task from one reviewed seed.
- [x] Persist promotion state back to the planning task seed record.
- [x] Expose read-only promotion diagnostics.
- [x] Validate duplicate, blocked, rejected, and already-promoted paths.

## Execution Plan

- [x] Batch 1: define promotion admission model and blocked reasons.
- [x] Batch 2: implement task-domain promotion command without provider
  execution.
- [x] Batch 3: persist promotion state and idempotency evidence.
- [x] Batch 4: expose promotion diagnostics through server/CLI/Effigy.
- [x] Batch 5: validate and choose whether next lane is planning sessions,
  management projection implementation, or task readiness linkage.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/467-task-seed-promotion-admission-selection.md`
- `batch-cards/468-task-seed-promotion-command-model.md`
- `batch-cards/469-task-seed-promotion-state-persistence.md`
- `batch-cards/470-task-seed-promotion-diagnostics-query.md`
- `batch-cards/471-task-seed-promotion-cli-effigy.md`
- `batch-cards/472-task-seed-promotion-validation.md`
- `batch-cards/473-task-seed-promotion-next-lane-checkpoint.md`
- `batch-cards/474-task-seed-promotion-closeout.md`

## Acceptance Criteria

- [x] Promotion requires an explicit command.
- [x] Promotion creates a task through task-domain storage, not by renaming a
  seed.
- [x] Duplicate promotion is idempotent or rejected with a controlled reason.
- [x] Blocked, rejected, draft, and already-promoted seeds cannot create new
  tasks.
- [x] Provider execution, SCM/forge mutation, scoring policy, autonomous goal
  loops, and UI-triggered mutation remain out of scope.

## Stop Conditions

- Promotion would bypass task-domain command rules.
- Promotion would silently schedule agent work.
- Promotion would require final repo projection merge policy.
