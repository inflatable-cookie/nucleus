# 444 Task Project Workflow Gap Matrix

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../110-task-project-workflow-depth.md`

## Purpose

Turn the implementation audit into a compact task/project workflow gap matrix.

## Work

- [x] Create or update an architecture gap artifact for task/project workflow.
- [x] Separate implemented, missing, blocked, deferred, and risky surfaces.
- [x] Identify whether next-task readiness can be read-only and deterministic.
- [x] Identify any contract gaps before implementation begins.

## Acceptance Criteria

- [x] Matrix names the selected first slice.
- [x] Matrix names explicit non-goals.
- [x] Matrix preserves task mutation and provider effect boundaries.

## Result

Created `docs/architecture/task-project-workflow-gap-matrix.md`.

Selected first slice:

- deterministic read-only task readiness candidate projection.

Excluded from the first slice:

- scoring policy
- autonomous priority ranking
- goal loop execution
- task mutation
- provider execution
- visible UI design
