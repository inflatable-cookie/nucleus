# 139 Compile Task Authoring Input Semantics

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first editable task input shape.

## Scope

- Decide required fields for task creation.
- Decide editable fields for update.
- Define validation rules for title, project id, activity, importance, action
  type, acceptance criteria, and agent-readiness fields.
- Define fields that remain server-owned.

## Out Of Scope

- Implementing create/update commands.
- Desktop create/edit UI.
- Agent assignment.
- Runtime execution.

## Promotion Targets

- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/roadmaps/g01/020-task-authoring-and-edit-semantics.md`

## Acceptance Criteria

- [x] Task authoring input shape is explicit.
- [x] Server-owned fields are explicit.
- [x] Next implementation card is narrow.

## Result

Task authoring input is now specified in the task and server boundary
contracts. The next narrow implementation card is task storage round-trip
support for create/update-safe fields.
