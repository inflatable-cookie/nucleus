# 018 Task Mutation Command Boundary Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Prepare server-owned task mutation commands before any task mutation UI exists.

## Scope

- Define first executable task mutation semantics.
- Decide command DTO shape for task mutations.
- Decide storage update behavior for create/update/state transitions.
- Keep runtime execution and agent assignment separate.

## Out Of Scope

- Desktop task mutation controls.
- Agent assignment UI.
- Task execution.
- Runtime scheduling.
- Validation command execution.

## Decisions

- Existing task command names are not enough for UI mutation readiness.
- Mutation UI is blocked until server command handling performs durable
  task-state updates.
- Command DTO support must be explicit before desktop can submit mutations.
- The first executable task mutation subset is activity transitions for
  existing task records: start, block with reason, complete, and archive.
- Task create and full update stay deferred until editable task input and full
  task authoring semantics are specified.
- First state transitions update only activity state and preserve all other
  stored display fields.
- Runtime execution, agent assignment, validation command execution, and SCM
  work sessions remain outside task mutation command handling.

## Execution Plan

- [x] Compile task mutation command semantics.
- [x] Add task command DTO readiness or implementation card.
- [x] Add server task mutation execution card.
- [x] Reassess desktop task mutation UI readiness.

## Acceptance Criteria

- [x] First task mutation semantics are written down.
- [x] Command DTO requirements are explicit.
- [x] Storage update behavior is explicit.
- [x] Desktop mutation UI remains blocked until server authority exists.

## Cards

- `docs/roadmaps/g01/batch-cards/131-compile-task-mutation-command-semantics.md`
- `docs/roadmaps/g01/batch-cards/132-add-task-command-dto-readiness-or-implementation.md`
- `docs/roadmaps/g01/batch-cards/133-add-server-task-mutation-execution.md`
- `docs/roadmaps/g01/batch-cards/134-reassess-desktop-task-mutation-ui-readiness.md`
