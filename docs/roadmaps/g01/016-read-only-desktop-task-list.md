# 016 Read-Only Desktop Task List

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Render server-owned task records in the desktop shell.

## Scope

- Add TypeScript helpers for `task_records` responses where needed.
- Add a read-only task list panel.
- Filter task display by selected project id as local view glue.
- Keep task authority in Rust.

## Out Of Scope

- Task creation.
- Task editing.
- Assignment controls.
- Agent execution.
- Persisted task selection.
- Server-side filtered task queries.

## Decisions

- The first task list can query all task records and filter by
  `selectedProjectId` in the shell. This is display filtering, not state
  authority.
- The panel should render empty, loading, and error states.
- The panel should not invent task status or project membership beyond the
  typed DTO.

## Execution Plan

- [x] Add read-only desktop task list panel.
- [x] Wire task list to selected project shell state.
- [x] Reassess first task detail or task action readiness.

## Acceptance Criteria

- [x] Desktop shows seeded task records from the server.
- [x] Project selection limits visible tasks by `project_id`.
- [x] TypeScript remains display glue.
- [x] No task mutation path is introduced.

## Cards

- `docs/roadmaps/g01/batch-cards/125-add-read-only-task-list-panel.md`
- `docs/roadmaps/g01/batch-cards/126-wire-task-list-to-selected-project.md`
- `docs/roadmaps/g01/batch-cards/127-reassess-task-detail-or-action-readiness.md`
