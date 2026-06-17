# 005 Engine Task Command Service

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Create the first engine-owned task command service boundary.

## Scope

- Engine task command input/output types where server DTOs should not leak.
- Repository trait shape needed by task command mutation.
- Mapping between orchestration admission outcome and engine command result.
- No behavior expansion beyond existing task create/update/activity
  transitions.

## Out Of Scope

- Provider runtime.
- Timeline projection.
- SCM mutation.
- UI changes.
- Remote transport.

## Promotion Targets

- `crates/nucleus-engine`
- `crates/nucleus-server`
- `docs/roadmaps/g02/003-engine-task-command-boundary.md`

## Acceptance Criteria

- [x] `nucleus-engine` exposes a task command service API independent of
  `nucleus-server`.
- [x] The service can represent the current task command outcomes needed by the
  server request handler.
- [x] The service does not depend on Tauri, server DTOs, or local transport.

## Stop Conditions

- The service needs new task semantics not covered by `005-task-contract.md`.

## Outcome

Added the first engine-owned task command service boundary in
`crates/nucleus-engine/src/task_commands.rs`.
