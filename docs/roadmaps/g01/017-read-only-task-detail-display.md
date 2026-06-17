# 017 Read-Only Task Detail Display

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Show selected task details without adding task mutation authority.

## Scope

- Add local task selection in the desktop shell.
- Add a read-only task detail panel.
- Render existing task DTO fields.
- Keep detail display synchronized with selected project filtering.

## Out Of Scope

- Task creation.
- Task editing.
- Assignment controls.
- Agent execution.
- Server command mutation handling.
- Persisted task selection.

## Decisions

- Task detail display can proceed before task mutation.
- Task actions remain blocked until server command handling owns task
  mutations and runtime scheduling decisions.
- The first detail panel should consume the existing typed DTO and not request
  raw storage records.

## Execution Plan

- [x] Add shell-level task selection.
- [x] Add read-only task detail panel.
- [x] Reassess task mutation command readiness.

## Acceptance Criteria

- [x] A visible task can be selected locally.
- [x] Detail display uses typed task DTO fields.
- [x] No mutation, assignment, or execution controls are added.
- [x] The next mutation boundary is explicit before task controls are planned.

## Cards

- `docs/roadmaps/g01/batch-cards/128-add-shell-level-task-selection.md`
- `docs/roadmaps/g01/batch-cards/129-add-read-only-task-detail-panel.md`
- `docs/roadmaps/g01/batch-cards/130-reassess-task-mutation-command-readiness.md`
