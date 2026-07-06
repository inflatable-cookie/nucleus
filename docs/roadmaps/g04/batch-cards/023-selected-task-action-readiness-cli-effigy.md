# 023 Selected Task Action Readiness CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../005-selected-task-action-readiness.md`

## Purpose

Expose selected-task action readiness through `nucleusd` and Effigy.

## Work

- [x] Add control DTOs if the read model shape is stable.
- [x] Add `nucleusd query selected-task-action-readiness`.
- [x] Add an Effigy selector.
- [x] Add focused CLI rendering tests.

## Acceptance Criteria

- [x] The action readiness surface can be inspected from root.
- [x] CLI output shows action statuses and blockers.
- [x] No action execution is introduced.

## Result

Added the selected-task action readiness query and control DTOs.

Surfaces:

- control query: `SelectedTaskActionReadiness`
- control response body: `selected_task_action_readiness`
- CLI: `nucleusd query selected-task-action-readiness --project <project-id>
  --task <task-id>`
- Effigy: `server:query:selected-task-action-readiness`

The CLI renderer shows action statuses, blockers, source counts, and explicit
no-effect flags. It does not execute task, provider, SCM, planning, memory,
projection, scheduling, or UI effects.
