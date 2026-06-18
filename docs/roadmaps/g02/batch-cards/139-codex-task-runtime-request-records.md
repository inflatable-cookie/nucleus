# 139 Codex Task Runtime Request Records

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../032-codex-task-runtime-admission-bridge.md`

## Purpose

Model Codex runtime requests scoped to task work units.

## Scope

- Add task, work-unit, adapter, session, and command refs.
- Preserve Codex-specific runtime refs separately.
- Keep requests admission-only.

## Acceptance Criteria

- [x] Codex task runtime requests are typed.
- [x] Generic work units do not depend on Codex-only fields.
- [x] No process launch occurs.

## Result

Added `CodexTaskRuntimeRequestRecord` with task, work-unit, source, adapter,
command, event, session, and Codex provider refs. The record is admission-only.

## Validation

- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if request records need auth or process credentials.
