# 214 Compose Sandbox Readiness With Runtime Discovery

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Compose concrete sandbox readiness with local runtime discovery.

## Scope

- Replace unsupported sandbox descriptor with concrete readiness.
- Keep process-control descriptor unsupported.
- Prove artifact, event, and sandbox blockers are removed together.

## Out Of Scope

- Process spawn.
- Process-control implementation.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Sandbox blocker is removed when readiness is concrete.
- Process-control blocker remains.
- Tests remain non-spawning.
