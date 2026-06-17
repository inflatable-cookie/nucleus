# 158 Add Process Supervision Readiness Types

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add Rust readiness vocabulary for local process supervision.

## Scope

- Name supervisor readiness.
- Name timeout and cancellation posture.
- Name output capture and sandbox blockers.

## Out Of Scope

- Process spawning.
- Async runtime selection.
- PTY streaming.

## Promotion Targets

- `crates/nucleus-command-policy`
- `crates/nucleus-server`

## Acceptance Criteria

- Readiness types compile.
- Tests prove blocked states remain explicit.
- No process is spawned.

## Closeout

- Added process supervision readiness vocabulary to `nucleus-command-policy`.
- Tests prove blocked and ready states remain explicit without spawning.
- No process spawning was introduced.
