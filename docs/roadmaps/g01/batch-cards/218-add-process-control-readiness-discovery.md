# 218 Add Process-Control Readiness Discovery

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Produce process-control readiness from the local process-control backend.

## Scope

- Discover spawn readiness.
- Report timeout readiness.
- Report cancellation readiness.
- Report cleanup readiness.
- Produce implementation evidence refs.

## Out Of Scope

- Real process spawn.
- Shell passthrough.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Discovery reports concrete local process-control readiness.
- Missing implementation evidence blocks readiness.
- Tests remain non-spawning.
