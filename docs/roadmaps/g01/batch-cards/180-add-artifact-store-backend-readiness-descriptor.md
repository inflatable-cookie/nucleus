# 180 Add Artifact Store Backend Readiness Descriptor

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a typed artifact store backend readiness descriptor for host-spawn gating.

## Scope

- Name artifact store backend kind.
- Name supported payload classes.
- Name retention and redaction evidence refs.
- Keep missing payload storage blocked.

## Out Of Scope

- Implementing artifact payload storage.
- Child process spawning.
- Desktop artifact viewers.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Artifact store readiness is typed.
- Unsupported raw-output payload storage blocks spawn.
- Descriptor carries evidence refs without payload bytes.

## Closeout

- Added artifact store backend readiness descriptor.
- Descriptor names backend kind, supported payload classes, payload storage
  readiness, retention evidence refs, and redaction evidence refs.
- Tests prove missing storage readiness or evidence blocks support.
