# 470 Task Seed Promotion Diagnostics Query

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../113-task-seed-promotion-command.md`

## Purpose

Expose read-only diagnostics for promotion readiness and outcomes.

## Work

- [x] Add promotion diagnostic projection.
- [x] Count ready, blocked, rejected, promoted, and duplicate states.
- [x] Keep diagnostics read-only.

## Acceptance Criteria

- [x] Diagnostics expose no mutation authority.
- [x] Counts match persisted task seed records.
- [x] Raw planning bodies and private refs are not exposed.

## Result

- Added server-owned promotion diagnostics over persisted Planning/TaskSeed
  records and promoted task refs.
- Diagnostics count ready, blocked, rejected, promoted, duplicate promoted
  task-ref, and missing promoted task-ref states.
- The projection exposes sanitized ids and counts only; it does not expose raw
  planning body, context refs, planning bodies, provider output, or mutation
  authority.
