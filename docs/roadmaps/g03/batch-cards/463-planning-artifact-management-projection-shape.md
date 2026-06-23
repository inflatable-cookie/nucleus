# 463 Planning Artifact Management Projection Shape

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../112-planning-task-seed-persistence-and-projection.md`

## Purpose

Define how planning artifacts and task seeds should appear in repo-backed
management projection files.

## Work

- [x] Map planning artifact/task seed fields to management projection payloads.
- [x] Document merge and review gaps.
- [x] Avoid implementing repository writes in this card.

## Acceptance Criteria

- [x] Projection shape is explicit enough for a later implementation card.
- [x] Multi-user merge policy gaps are named.
- [x] No SCM/forge mutation is added.

## Result

- Added `docs/architecture/planning-management-projection-shape.md`.
- Defined planning artifact and task seed file paths and payload fields.
- Named merge/review gaps before projection import/export implementation.
- Kept repository writes and SCM/forge mutation out of scope.
