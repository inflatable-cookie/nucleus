# 176 Add Host Spawn Readiness Gate Tests

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add tests proving the host-spawn readiness gate blocks incomplete runtime
surfaces.

## Scope

- Test missing sandbox enforcement.
- Test missing artifact payload store.
- Test missing event transport.
- Test missing timeout/cancellation implementation.
- Test all blockers are visible together.

## Out Of Scope

- Child process spawning.
- Backend-specific sandbox tests.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Tests prove incomplete runtime surfaces keep spawn blocked.
- Tests do not spawn child processes.
- Tests preserve blocker detail for UI/diagnostics.

## Closeout

- Added focused host-spawn readiness gate tests for artifact store, event
  transport, interruption contract, and process-control blockers.
- Added combined blocker detail test for diagnostics and UI reporting.
- Kept the gate non-spawning.
