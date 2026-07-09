# 072 Selected Task Completion Route Control Surfaces

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../015-selected-task-completion-from-route-admission.md`

## Purpose

Expose completion-from-route state through server control DTOs, `nucleusd`, and
Effigy.

## Work

- [x] Add request/response DTOs for completion-from-route preview/apply evidence.
- [x] Add `nucleusd` query or command output with focused rendering tests.
- [x] Add an Effigy selector for the safe inspection path.
- [x] Keep raw provider payloads and local desktop state out of the response.

## Acceptance Criteria

- [x] CLI and Effigy show the same server-owned state.
- [x] Query surfaces are read-only unless an explicit apply command is in scope.
- [x] Output includes route, decision, evidence, receipt, and no-effect fields.

## Result

Added a server-owned selected-task completion-route apply preview query.

The query composes review outcome routing, operator action gating, route
admission, and the pure completion-route apply model. It defaults optional route
admission, review decision, and evidence refs from the computed server route
admission so clients can inspect the current state without fabricating refs.

Added:

- `ServerQueryKind::SelectedTaskCompletionRouteApply`
- control request and response DTO serialization
- sanitized response record DTOs with command, command admission, route,
  decision, evidence, refusal, operator, and no-effect fields
- `nucleusd query selected-task-completion-route-apply`
- Effigy selector `server:query:selected-task-completion-route-apply`

The surface is read-only. It does not execute the exposed task command, mutate
task lifecycle state, schedule providers, write projections, or expose raw
provider payloads.

## Validation

- `cargo test -p nucleus-server selected_task_completion_route_apply -- --nocapture`
- `cargo test -p nucleusd selected_task_completion_route_apply -- --nocapture`
- `effigy server:query:selected-task-completion-route-apply`
