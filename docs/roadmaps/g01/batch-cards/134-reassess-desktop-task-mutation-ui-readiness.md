# 134 Reassess Desktop Task Mutation UI Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Decide whether desktop task mutation controls can be planned.

## Scope

- Check command DTO support.
- Check server mutation execution.
- Check validation and error surfaces.
- Decide the next desktop task lane.

## Out Of Scope

- Implementing mutation UI.
- Implementing assignment UI.
- Implementing runtime execution.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- Desktop mutation readiness is explicit.
- Missing server authority remains visible if still blocked.

## Result

Desktop mutation UI is ready only for the first activity-transition subset:

- start
- block with reason
- complete
- archive

It is not ready for task creation, full editing, assignment, validation command
execution, agent execution, or SCM work-session creation.

Next lane: add desktop task transition controls against the existing command
DTO and server execution path.
