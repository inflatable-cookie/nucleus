# 125 Add Read-Only Task List Panel

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Show server-owned task records in the desktop shell.

## Scope

- Add a Svelte task list panel.
- Query task records through `buildStateListQuery("tasks")`.
- Render loading, empty, error, and record states.
- Keep records read-only.

## Out Of Scope

- Task mutation.
- Task detail editing.
- Agent assignment.
- Task execution.
- Persisted selection.

## Promotion Targets

- `apps/desktop/src/lib`
- `apps/desktop/src/App.svelte`
- `apps/desktop/src/styles.css`
- `apps/desktop/README.md`

## Acceptance Criteria

- Task records render from the `task_records` DTO.
- The panel does not render raw storage envelopes.
- No task creation, editing, assignment, or execution control is added.
- Desktop typecheck and build pass.

## Validation

```sh
bun run check
bun run build
cargo test -p nucleus-desktop
```

## Result

Added a read-only task list panel that queries `buildStateListQuery("tasks")`
and renders typed `task_records` DTOs.

The panel includes loading, empty, error, record, and refresh states. It does
not add task creation, editing, assignment, execution, or persisted selection.

Validation passed for typecheck, build, and focused Rust tests. Visual browser
smoke was attempted through local Playwright, but the Playwright browser binary
is not installed in this environment.
