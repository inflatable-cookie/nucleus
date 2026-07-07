# 071 Selected Task Completion Route Command Composition

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../015-selected-task-completion-from-route-admission.md`

## Purpose

Compose completion route apply with existing task command admission and command
receipt paths.

## Work

- [x] Add the server-side composition model in focused modules.
- [x] Reuse selected-task command admission for the task completion command.
- [x] Preserve route, review decision, evidence, and command refs in the result.
- [x] Add focused tests for admitted, refused, stale, and no-effect paths.

## Acceptance Criteria

- [x] The model does not create a second task lifecycle authority.
- [x] The result distinguishes admission preview from command apply receipt.
- [x] Tests prove no provider, SCM, planning, memory, or UI effects.

## Result

Added `selected_task_completion_route_apply` as a pure server composition
module. It validates explicit operator intent against an admitted completion
route and exposes the existing selected-task complete command for a later
server command boundary.

The model refuses missing expected revision, mismatched route admission id,
mismatched review decision, evidence refs not present on the route, stale
command revision, refused route admission, refused command admission, and
unsupported non-complete commands.

Validation:

- `cargo test -p nucleus-server selected_task_completion_route_apply -- --nocapture`
- `cargo test -p nucleus-server selected_task_route_admission -- --nocapture`
