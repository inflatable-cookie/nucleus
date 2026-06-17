# 127 Reassess Task Detail Or Action Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Decide the next useful task surface after read-only list display.

## Scope

- Check task detail-readiness.
- Check task action-readiness.
- Decide whether the next lane is task detail display, task creation, or
  assignment/action planning.

## Out Of Scope

- Implementing task mutation.
- Implementing assignment.
- Implementing execution.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- Next task lane is explicit.
- Missing server authority remains visible if mutation is not ready.

## Result

Next task lane: read-only task detail display.

Task detail display is ready because the desktop already receives typed task
DTO fields including title, description, project id, activity, action type,
importance, assignment intent, agent-readiness flag, and revision id.

Task action and mutation readiness is not ready. Task creation, editing,
assignment, action dispatch, and execution need explicit server command
handling before UI controls can exist.
