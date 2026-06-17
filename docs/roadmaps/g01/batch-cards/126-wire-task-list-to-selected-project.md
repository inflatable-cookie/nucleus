# 126 Wire Task List To Selected Project

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Constrain read-only task display to the selected project.

## Scope

- Pass selected project id into the task list panel.
- Filter visible task DTOs by `project_id`.
- Render an empty state when the selected project has no tasks.

## Out Of Scope

- Server-side query filtering.
- Persisted project focus.
- Task mutation.

## Promotion Targets

- `apps/desktop/src/App.svelte`
- `apps/desktop/src/lib`
- `apps/desktop/README.md`

## Acceptance Criteria

- Selecting a project controls which task records are visible.
- Filtering remains local display glue.
- No task authority moves into TypeScript.

## Result

The task list now accepts the shell-selected project id and filters visible
task DTOs by `project_id`.

Filtering stays local and read-only. The server query still returns task
records through the control boundary, and TypeScript does not create, edit,
assign, or execute tasks.
