# 217 Define Read-Only Spawn Control Readiness

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define readiness for the first bounded read-only process-control slice.

## Scope

- Require finite timeout support.
- Require cooperative cancellation support.
- Require cleanup failure reporting support.
- Keep shell passthrough and PTY out.

## Out Of Scope

- Real process spawn.
- Interactive commands.
- Remote execution.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Read-only spawn control readiness is explicit.
- Missing timeout, cancellation, or cleanup readiness blocks support.
- Tests remain non-spawning.
