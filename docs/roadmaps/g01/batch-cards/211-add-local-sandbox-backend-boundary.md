# 211 Add Local Sandbox Backend Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add the first concrete local sandbox backend boundary.

## Scope

- Name local sandbox identity and execution-host ownership.
- Keep enforced, advisory, and unsupported postures distinct.
- Keep platform limits explicit.
- Keep the boundary in `nucleus-server`.

## Out Of Scope

- Process spawn.
- Shell passthrough.
- Remote sandboxing.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Backend boundary compiles.
- Boundary can report readiness without spawning a process.
- Host-spawn readiness remains blocked by process-control descriptors.
