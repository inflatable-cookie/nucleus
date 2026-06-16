# 014 Read-Only Desktop Project Switcher

Status: active
Owner: Tom
Updated: 2026-06-17

## Goal

Add the first project-oriented desktop panel using server-owned project records.

## Scope

- Add a read-only project switcher panel.
- Query `project_records` through the existing Tauri command path.
- Render loading, empty, error, and loaded states.
- Allow local UI selection of a visible project.
- Keep creation/editing deferred.

## Out Of Scope

- Project creation.
- Project editing.
- Repo membership display or repair.
- Task panels.
- Workspace persistence.
- Live subscriptions.

## Decisions

- The first switcher is display/list/select only.
- Desktop TypeScript may hold selected project id as local view state.
- Project authority remains in Rust/server-owned storage and DTOs.

## Execution Plan

- [x] Add read-only project switcher panel.
- [ ] Wire project selection into the shell layout.
- [ ] Reassess task list readiness after project selection exists.

## Acceptance Criteria

- [x] Project switcher lists display-ready project records from the server.
- [x] Desktop has loading, empty, error, and selected states.
- [x] No project mutation behavior is added.
- [x] TypeScript does not decode raw project storage payloads.

## Cards

- `docs/roadmaps/g01/batch-cards/118-add-read-only-project-switcher-panel.md`
- `docs/roadmaps/g01/batch-cards/119-wire-project-selection-into-shell.md`
- `docs/roadmaps/g01/batch-cards/120-reassess-task-list-readiness.md`
