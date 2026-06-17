# 136 Add Task Detail Transition Controls

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Expose limited task transition controls in task detail display.

## Scope

- Add start, block, complete, and archive controls.
- Require reason input for block.
- Submit command DTOs through the existing desktop command path.
- Render pending and error states.

## Out Of Scope

- Local optimistic mutation.
- Task creation/editing.
- Assignment or execution controls.

## Promotion Targets

- `apps/desktop/src/lib/TaskDetailPanel.svelte`
- `apps/desktop/src/styles.css`
- `apps/desktop/README.md`

## Acceptance Criteria

- Supported transition controls submit commands.
- Rejected commands render errors.
- No unsupported task mutation controls are added.

## Result

Added task detail controls for start, block, complete, and archive.

Block requires a reason. Commands submit through the existing desktop control
envelope path and render command receipt or error state. No create, edit,
assignment, execution, or validation controls were added.
