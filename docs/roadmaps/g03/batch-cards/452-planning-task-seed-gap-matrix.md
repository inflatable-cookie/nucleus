# 452 Planning Task Seed Gap Matrix

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../111-planning-artifact-task-seed-promotion.md`

## Purpose

Convert the audit into a planning-to-task seed gap matrix.

## Work

- [x] Record implemented, missing, blocked, deferred, and risky surfaces.
- [x] Decide the first record shape and ownership boundary.
- [x] Decide whether promotion command work is in or out of the current lane.

## Acceptance Criteria

- [x] First implementation slice is explicit.
- [x] Silent task creation is ruled out.
- [x] Provider, SCM/forge, scoring, goal-loop, and UI non-goals are preserved.

## Result

Created `docs/architecture/planning-task-seed-gap-matrix.md`.

Selected slice:

- portable engine record and projection types for planning artifacts and task
  seed candidates.

Deferred:

- persistence
- server query
- task creation
- task seed promotion command
- management projection export
