# 186 Add Unsupported Local Host Discovery Fixture

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a fixture for a local host whose runtime backends are discovered as
unsupported or advisory only.

## Scope

- Build a deterministic unsupported local host discovery output.
- Include backend descriptor evidence refs that explain missing support.
- Keep fixture data static and non-spawning.

## Out Of Scope

- Detecting real machine capabilities.
- Running commands.
- Writing artifacts.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Fixture returns complete backend descriptor groups.
- Unsupported fixture keeps all spawn-relevant backend readiness blocked.
- Tests prove fixture construction is deterministic.

## Closeout

- Added `unsupported_local_host_runtime_discovery` as a deterministic server
  fixture.
- Fixture returns sandbox, artifact store, event transport, and process-control
  descriptors for the requested host.
- Backend descriptor evidence refs explain unsupported capability while all
  spawn-relevant readiness checks remain blocked.
- Tests prove deterministic construction and blocked spawn-relevant backend
  readiness.
