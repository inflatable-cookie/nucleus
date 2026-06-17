# 175 Add Host Spawn Readiness Gate Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add server-owned host-spawn readiness gate vocabulary without spawning
processes.

## Scope

- Add readiness status and blocker types.
- Compose authority, supervisor, sandbox, artifact, event transport, timeout,
  cancellation, and process-control blockers.
- Keep the surface value-shaped.

## Out Of Scope

- Child process spawning.
- OS sandbox implementation.
- Artifact storage.
- Event transport.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Readiness gate compiles.
- Missing sandbox enforcement blocks readiness.
- Gate does not spawn processes.

## Closeout

- Added server-owned host-spawn readiness gate input, status, blocker, and
  result types.
- Gate composes authority, supervisor, sandbox, artifact, event transport,
  interruption, and process-control readiness.
- Initial tests prove missing sandbox enforcement blocks readiness and a fully
  satisfied value can be named ready without spawning.
