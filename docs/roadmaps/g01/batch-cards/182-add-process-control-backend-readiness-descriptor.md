# 182 Add Process Control Backend Readiness Descriptor

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a typed process-control backend readiness descriptor for host-spawn gating.

## Scope

- Name process-control backend kind.
- Declare spawn, timeout, cancellation, and cleanup support.
- Capture implementation evidence refs.

## Out Of Scope

- Implementing process spawning.
- Implementing cancellation or cleanup.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Process-control readiness is typed.
- Missing timeout, cancellation, or cleanup support blocks spawn.
- Descriptor remains async-runtime agnostic.

## Closeout

- Added process-control backend readiness descriptor.
- Descriptor names backend kind, spawn, timeout, cancellation, cleanup, and
  implementation evidence refs.
- Tests prove missing cancellation/cleanup/evidence blocks future spawn.
