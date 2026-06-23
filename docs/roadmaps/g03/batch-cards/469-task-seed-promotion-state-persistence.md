# 469 Task Seed Promotion State Persistence

Status: planned
Owner: Tom
Updated: 2026-06-23
Milestone: `../113-task-seed-promotion-command.md`

## Purpose

Persist promotion state back to the planning task seed record.

## Work

- [ ] Update seed promotion state after successful task creation.
- [ ] Preserve promoted task ref.
- [ ] Handle already-promoted seeds deterministically.

## Acceptance Criteria

- [ ] Promotion state survives storage round-trip.
- [ ] Duplicate promotion cannot create duplicate tasks.
- [ ] Decode failures return controlled errors.
