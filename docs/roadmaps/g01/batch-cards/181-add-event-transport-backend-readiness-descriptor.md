# 181 Add Event Transport Backend Readiness Descriptor

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a typed process event transport readiness descriptor for host-spawn gating.

## Scope

- Name event transport kind.
- Declare support for running, terminal, and cleanup-failed supervision events.
- Capture delivery and replay evidence refs.

## Out Of Scope

- Implementing event transport.
- Network transport.
- Desktop event subscriptions.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Event transport readiness is typed.
- Missing terminal or cleanup-failed event support blocks spawn.
- Descriptor remains transport-backend agnostic.

## Closeout

- Added process event transport readiness descriptor.
- Descriptor names backend kind, supported supervision events, delivery
  evidence refs, and replay evidence refs.
- Tests prove missing terminal/cleanup-failed support or evidence blocks
  readiness.
