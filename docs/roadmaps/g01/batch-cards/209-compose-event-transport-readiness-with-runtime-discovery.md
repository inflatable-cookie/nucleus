# 209 Compose Event Transport Readiness With Runtime Discovery

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Compose concrete event transport readiness with local runtime discovery.

## Scope

- Replace unsupported event transport descriptor with concrete readiness.
- Keep sandbox and process-control descriptors unsupported.
- Prove artifact and event blockers are removed together.

## Out Of Scope

- Process spawn.
- Sandbox implementation.
- Process-control implementation.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Event transport blocker is removed when readiness is concrete.
- Sandbox and process-control blockers remain.
- Tests remain non-spawning.
