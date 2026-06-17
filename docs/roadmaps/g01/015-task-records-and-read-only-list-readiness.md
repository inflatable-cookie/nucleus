# 015 Task Records And Read-Only List Readiness

Status: active
Owner: Tom
Updated: 2026-06-17

## Goal

Prepare enough task state behavior for a useful read-only desktop task list.

## Scope

- Define first task storage/display record path.
- Add a server-owned task display DTO/projection.
- Decide how local seed or create behavior enters task storage.
- Reassess read-only task list readiness.

## Out Of Scope

- Task mutation UI.
- Agent assignment UI.
- Task execution.
- Validation command execution.
- Project/task prioritisation scoring.

## Decisions

- A task list should not render raw opaque storage records.
- First task display records should mirror the project pattern: Rust-owned
  codec plus server control DTO/projection.
- Local seed behavior should come before task creation UI.
- The first display-data path is a Rust-owned task storage codec in
  `nucleus-tasks`, projected by `nucleus-server` into a typed `task_records`
  control DTO.
- The first write path is a server-owned local seed task attached to the
  `Nucleus Local` project. This is bootstrap data, not task creation UI.
- TypeScript remains display glue: query construction, list rendering, local
  shell selection, and error states only.

## Execution Plan

- [x] Compile task record display and seed runway.
- [x] Add task record storage codec or display projection.
- [ ] Add local task seed or create path.
- [ ] Reassess read-only task list readiness.

## Acceptance Criteria

- [x] Task display fields are available through a server-owned boundary.
- [ ] Local storage can contain at least one valid task record through an
  intentional server path.
- [ ] Read-only task list readiness is explicit.
- [ ] TypeScript remains view glue and does not own task authority.

## Cards

- `docs/roadmaps/g01/batch-cards/121-compile-task-record-display-and-seed-runway.md`
- `docs/roadmaps/g01/batch-cards/122-add-task-record-storage-codec-or-display-projection.md`
- `docs/roadmaps/g01/batch-cards/123-add-local-task-seed-or-create-path.md`
- `docs/roadmaps/g01/batch-cards/124-reassess-read-only-task-list-readiness.md`
