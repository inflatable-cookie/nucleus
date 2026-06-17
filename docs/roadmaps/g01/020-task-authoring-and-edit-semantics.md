# 020 Task Authoring And Edit Semantics

Status: complete
Owner: Tom
Updated: 2026-06-17

## Goal

Define task creation and editing semantics before UI mutation controls exist.

## Scope

- Define editable task input shape.
- Define create/update validation rules.
- Define storage round-trip requirements beyond display DTOs.
- Define revision conflict behavior for edit forms.

## Out Of Scope

- Desktop create/edit UI.
- Agent assignment UI.
- Runtime execution.
- Validation command execution.

## Decisions

- Task create/edit stays blocked until storage round-trip support exists.
- Display DTOs are not enough for full task editing.
- Task authoring must preserve acceptance criteria, readiness fields, and
  future projection compatibility.
- Task authoring input is separate from display DTOs and raw storage records.
- Create requires project id, non-empty title, action type, importance, and
  proposed/ready/active activity.
- Update requires task id and expected revision when the edit is based on a
  client-visible record.
- Server-owned fields include task id generation, revision, timestamps, task
  history, assignment snapshots, adapter-observed links, runtime refs, command
  evidence refs, and projection paths.
- Storage round-trip support now covers create/update-safe fields, including
  readiness refs, while leaving server-owned runtime/history fields out.
- Server task create/update command handling now exists behind the control DTO
  boundary with validation, revision expectations, and typed read-after-write.
- Desktop task create/edit UI is deferred. The desktop remains a disposable
  proof interface while server runtime work continues.

## Execution Plan

- [x] Compile task authoring input semantics.
- [x] Add task storage round-trip support.
- [x] Add task create/update command DTO and execution path.
- [x] Reassess desktop task create/edit UI readiness.

## Acceptance Criteria

- [x] Editable task input shape is explicit.
- [x] Storage round-trip behavior is explicit or implemented.
- [x] Create/update command behavior is explicit or implemented.
- [x] Desktop create/edit UI remains blocked until server authority exists.

## Cards

- `docs/roadmaps/g01/batch-cards/139-compile-task-authoring-input-semantics.md`
- `docs/roadmaps/g01/batch-cards/140-add-task-storage-round-trip-support.md`
- `docs/roadmaps/g01/batch-cards/141-add-task-create-update-command-path.md`
- `docs/roadmaps/g01/batch-cards/142-reassess-desktop-task-create-edit-ui-readiness.md`
