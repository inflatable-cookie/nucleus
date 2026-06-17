# 137 Refresh Task Records After Transition

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Refresh server-owned task records after accepted transition commands.

## Scope

- Trigger task list reload after accepted transition receipt.
- Keep selected task synchronized with refreshed DTOs.
- Preserve local selected project filtering.

## Out Of Scope

- Optimistic local task mutation.
- Live subscriptions.
- Server-side filtered task queries.

## Promotion Targets

- `apps/desktop/src/App.svelte`
- `apps/desktop/src/lib/TaskListPanel.svelte`
- `apps/desktop/src/lib/TaskDetailPanel.svelte`

## Acceptance Criteria

- Accepted transition commands refresh visible task records.
- Selected task detail updates from refreshed server DTOs.
- Local state does not fake server mutation success.

## Result

Accepted task transition command receipts now trigger server task refresh.

The task list reloads from `task_records`, keeps selected-project filtering,
and rebinds selected task detail from the refreshed DTO. The desktop does not
optimistically mutate task DTOs locally.
