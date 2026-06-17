# 216 Add Local Process-Control Backend Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add the first concrete local process-control backend boundary.

## Scope

- Name local process-control identity and execution-host ownership.
- Represent spawn, timeout, cancellation, and cleanup readiness.
- Keep process-control behavior value-only in this slice.

## Out Of Scope

- Real process spawn.
- Shell passthrough.
- PTY or terminal rendering.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Backend boundary compiles.
- Boundary can report readiness without spawning a process.
- Readiness keeps timeout, cancellation, and cleanup separate.
