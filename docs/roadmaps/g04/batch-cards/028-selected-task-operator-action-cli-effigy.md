# 028 Selected Task Operator Action CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../006-selected-task-operator-action-gate.md`

## Purpose

Expose selected-task operator action gate records through `nucleusd` and
Effigy.

## Work

- [x] Add control DTOs if the gate shape is stable.
- [x] Add a `nucleusd query` inspection surface.
- [x] Add an Effigy selector.
- [x] Add focused CLI rendering tests.

## Acceptance Criteria

- [x] The gate can be inspected from repo root.
- [x] CLI output distinguishes task-only candidates from deferred actions.
- [x] No command execution is introduced.

## Result

Added a transport DTO, local query handler, `nucleusd query
selected-task-operator-action-gate`, and Effigy selector
`server:query:selected-task-operator-action-gate`.

The CLI output separates task command candidates, blocked actions, read-only
actions, and deferred actions. It exposes no payloads and performs no command
execution.
