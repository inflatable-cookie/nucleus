# 128 Add Shell-Level Task Selection

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Let the desktop shell track one locally selected task.

## Scope

- Add shell-level selected task id state.
- Allow the task list to emit local selection.
- Clear selection when the selected project filter hides the selected task.

## Out Of Scope

- Persisted selection.
- Task detail panel.
- Task mutation.

## Promotion Targets

- `apps/desktop/src/App.svelte`
- `apps/desktop/src/lib/TaskListPanel.svelte`
- `apps/desktop/README.md`

## Acceptance Criteria

- Clicking a visible task updates shell-selected task id.
- Selection remains local display state.
- Hidden or missing selected tasks do not leave stale visible selection.

## Validation

```sh
bun run check
bun run build
```

## Result

Added shell-level `selectedTaskId` state.

The task list can now select a visible task locally and clears stale selection
when the selected project filter hides or removes that task. Selection remains
display state only.
