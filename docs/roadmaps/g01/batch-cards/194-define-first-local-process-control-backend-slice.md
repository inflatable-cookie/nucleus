# 194 Define First Local Process Control Backend Slice

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first concrete local process-control backend slice.

## Scope

- Pick the first process-control implementation strategy.
- Define spawn, timeout, cancellation, and cleanup evidence refs.
- Keep process-control implementation behind the readiness gate.

## Out Of Scope

- PTY handling.
- Terminal rendering.
- Remote process execution.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `crates/nucleus-server`

## Acceptance Criteria

- First process-control backend slice is narrow.
- Timeout, cancellation, and cleanup behavior are explicit.
- Spawn remains blocked without the other required backends.

## Closeout

- First process-control slice is local read-only command spawn.
- Finite timeout, bounded stdout/stderr, cancellation, cleanup, and sanitized
  evidence refs are mandatory.
- Shell passthrough, PTY handling, terminal rendering, and remote process
  execution are out of scope.
