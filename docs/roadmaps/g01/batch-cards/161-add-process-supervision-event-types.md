# 161 Add Process Supervision Event Types

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add Rust event vocabulary for process supervision state changes.

## Scope

- Add accepted, blocked, running, terminal, cleanup-failed event kinds.
- Use command request and evidence refs.
- Keep payloads raw-output free.

## Out Of Scope

- Child process spawning.
- Event transport.
- Artifact payload storage.

## Promotion Targets

- `crates/nucleus-command-policy`
- `crates/nucleus-server`

## Acceptance Criteria

- Event types compile.
- Tests prove refs are used instead of raw output.
- No process is spawned.

## Closeout

- Added command-policy process supervision event payload types.
- Added server event envelope binding supervision payloads to project and host
  refs.
- Kept the surface non-spawning and raw-output free.
