# 469 Task Seed Promotion State Persistence

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../113-task-seed-promotion-command.md`

## Purpose

Persist promotion state back to the planning task seed record.

## Work

- [x] Update seed promotion state after successful task creation.
- [x] Preserve promoted task ref.
- [x] Handle already-promoted seeds deterministically.

## Acceptance Criteria

- [x] Promotion state survives storage round-trip.
- [x] Duplicate promotion cannot create duplicate tasks.
- [x] Decode failures return controlled errors.

## Result

- Added `TaskCommand::PromoteSeed`.
- The local request handler now reads one Planning/TaskSeed record, admits it
  through the engine promotion model, creates one task through task-domain
  storage, and updates the seed to `Promoted`.
- Repeated promotion of an already-promoted seed is accepted as a no-op and
  does not create another task.
- Decode failures, blocked seeds, revision conflicts, and task-domain errors
  return controlled server errors.
- Added first serialized command DTO coverage for task seed promotion so the
  command enum stays exhaustive.
