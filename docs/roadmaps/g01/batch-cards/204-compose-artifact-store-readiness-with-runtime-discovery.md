# 204 Compose Artifact Store Readiness With Runtime Discovery

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Compose concrete artifact-store readiness with local runtime discovery.

## Scope

- Replace unsupported artifact-store descriptor with concrete readiness.
- Keep other backend descriptors unsupported.
- Prove host-spawn readiness remains blocked by non-artifact backends.

## Out Of Scope

- Process spawn.
- Event transport implementation.
- Sandbox implementation.
- Process-control implementation.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Artifact-store blocker is removed when readiness is concrete.
- Sandbox, event transport, and process-control blockers remain.
- Tests remain non-spawning.
