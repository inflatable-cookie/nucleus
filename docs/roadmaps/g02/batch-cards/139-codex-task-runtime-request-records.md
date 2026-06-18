# 139 Codex Task Runtime Request Records

Status: ready
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

- Codex task runtime requests are typed.
- Generic work units do not depend on Codex-only fields.
- No process launch occurs.

## Validation

- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if request records need auth or process credentials.
