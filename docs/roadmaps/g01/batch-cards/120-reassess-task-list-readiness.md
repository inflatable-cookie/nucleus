# 120 Reassess Task List Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Decide whether a read-only task list can follow project selection.

## Scope

- Check task record display readiness.
- Check task seed/create path.
- Check project-selected query shape.
- Decide the next implementation card.

## Out Of Scope

- Implementing task list.
- Task mutation.
- Agent assignment.

## Promotion Targets

- `docs/roadmaps/g01/014-read-only-desktop-project-switcher.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- [x] Task list readiness is explicit.
- [x] If ready, next card is scoped to read-only task display.
- [x] If not ready, blocker is routed to task record display/seed behavior.

## Decision

Task list is not ready yet.

Reasons:

- task list queries can return opaque task storage records, but no display-ready
  task DTO exists
- `nucleus-tasks` has rich task domain types and projection records, but no
  JSON storage codec equivalent to project records
- no local task seed/create path exists
- selected project state exists only as local view state, so project-scoped task
  queries should wait for task display and seed behavior

## Routed Blocker

Add task record display and seed readiness before building task list UI.
