# 019 Desktop Task Transition Controls

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Add limited desktop controls for server-owned task activity transitions.

## Scope

- Add TypeScript command helpers for task transition commands.
- Add read-only-detail action controls for start, block, complete, and archive.
- Submit commands through `submit_control_envelope`.
- Refresh task records after accepted transition commands.
- Render command failures without pretending local state changed.

## Out Of Scope

- Task creation.
- Full task editing.
- Assignment controls.
- Agent execution.
- Validation command execution.
- SCM work-session creation.

## Decisions

- Desktop controls may use the first transition subset only.
- Server remains authoritative for task state.
- Desktop should refresh after command receipt instead of mutating visible task
  DTOs locally.
- Block requires a reason.

## Execution Plan

- [x] Add desktop task transition command helpers.
- [x] Add task detail transition controls.
- [x] Wire task refresh after accepted commands.
- [x] Reassess task creation/edit readiness.

## Acceptance Criteria

- [x] Desktop can submit supported transition commands.
- [x] Accepted commands are followed by server task refresh.
- [x] Rejected commands render errors.
- [x] Unsupported task mutation paths stay absent from UI.

## Cards

- `docs/roadmaps/g01/batch-cards/135-add-desktop-task-transition-command-helpers.md`
- `docs/roadmaps/g01/batch-cards/136-add-task-detail-transition-controls.md`
- `docs/roadmaps/g01/batch-cards/137-refresh-task-records-after-transition.md`
- `docs/roadmaps/g01/batch-cards/138-reassess-task-create-edit-readiness.md`
