# 274 Codex Recovery Diagnostics

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../061-codex-session-recovery-gate.md`

## Purpose

Expose Codex recovery outcomes through read-only diagnostics.

## Scope

- Add client-safe diagnostics DTOs with next action hints.
- Show resume, repair, replacement-thread, and task-mutation gaps explicitly.
- Do not add desktop panels.
- Do not expose raw provider payloads.

## Acceptance Criteria

- Clients can inspect recovery status without command authority.
- Diagnostics serialize without raw provider data.
- Task-mutation gaps remain explicit.

## Validation

- targeted serialization tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics need UI design decisions.
