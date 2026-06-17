# 219 Compose Process-Control Readiness With Runtime Discovery

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Compose concrete process-control readiness with local runtime discovery.

## Scope

- Replace unsupported process-control descriptor with concrete readiness.
- Prove all backend blockers can be removed together.
- Keep real process spawn out of scope.

## Out Of Scope

- Real process spawn.
- Shell passthrough.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Process-control blocker is removed when readiness is concrete.
- Host-spawn readiness can report ready with all descriptors concrete.
- Tests remain non-spawning.
