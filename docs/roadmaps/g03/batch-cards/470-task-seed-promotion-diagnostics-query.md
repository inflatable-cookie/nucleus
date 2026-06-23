# 470 Task Seed Promotion Diagnostics Query

Status: planned
Owner: Tom
Updated: 2026-06-23
Milestone: `../113-task-seed-promotion-command.md`

## Purpose

Expose read-only diagnostics for promotion readiness and outcomes.

## Work

- [ ] Add promotion diagnostic projection.
- [ ] Count ready, blocked, rejected, promoted, and duplicate states.
- [ ] Keep diagnostics read-only.

## Acceptance Criteria

- [ ] Diagnostics expose no mutation authority.
- [ ] Counts match persisted task seed records.
- [ ] Raw planning bodies and private refs are not exposed.
