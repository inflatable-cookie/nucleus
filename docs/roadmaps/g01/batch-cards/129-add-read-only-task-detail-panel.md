# 129 Add Read-Only Task Detail Panel

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Render selected task details from typed DTO fields.

## Scope

- Add a read-only task detail panel.
- Render title, description, activity, action type, importance, assignment
  intent, agent-readiness flag, project id, and revision id.
- Render an empty state when no task is selected.

## Out Of Scope

- Task mutation.
- Assignment controls.
- Execution controls.
- Raw storage record rendering.

## Promotion Targets

- `apps/desktop/src/lib`
- `apps/desktop/src/App.svelte`
- `apps/desktop/src/styles.css`
- `apps/desktop/README.md`

## Acceptance Criteria

- Detail display uses typed task DTOs only.
- Empty, selected, and missing states are explicit.
- No mutation controls are added.

## Result

Added a read-only task detail panel that renders the selected task DTO.

The panel shows task title, description, project id, task id, action type,
importance, assignment intent, agent-readiness flag, and revision id. Empty
state is explicit. No mutation, assignment, or execution controls were added.
