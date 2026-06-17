# 183 Rewire Host Spawn Gate To Backend Descriptors

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Rewire the host-spawn readiness gate to use typed backend descriptors instead
of coarse booleans.

## Scope

- Replace sandbox/artifact/event/process-control booleans with descriptors.
- Preserve blocker detail.
- Keep gate value-shaped and non-spawning.

## Out Of Scope

- Child process spawning.
- Backend implementation.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Gate compiles with descriptor inputs.
- Tests prove descriptor blockers are preserved.
- Gate remains non-spawning.

## Closeout

- Replaced host-spawn gate backend booleans with typed backend descriptors.
- Gate blockers now carry backend kind for sandbox, artifact store, event
  transport, and process-control failures.
- Tests prove descriptor-backed blocker detail is preserved.
