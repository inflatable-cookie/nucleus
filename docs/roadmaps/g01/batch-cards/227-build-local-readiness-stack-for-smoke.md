# 227 Build Local Readiness Stack For Smoke

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Build the local readiness descriptor stack needed by read-only spawn smoke.

## Scope

- Compose artifact, event transport, sandbox, and process-control readiness.
- Produce a ready host-spawn gate for the smoke path.
- Keep descriptor creation explicit.

## Out Of Scope

- Runtime probing.
- Platform auto-detection.
- Remote execution.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Smoke readiness can become ready.
- Missing descriptor keeps blocker detail.
- Tests remain deterministic.

## Closeout

Added `LocalReadOnlySpawnSmokeInput` and
`build_local_read_only_spawn_smoke_input`.

The builder composes local artifact store, event transport, sandbox, and
process-control readiness, then evaluates the host-spawn gate with explicit
authority, supervisor acceptance, interruption, and artifact payload inputs.
