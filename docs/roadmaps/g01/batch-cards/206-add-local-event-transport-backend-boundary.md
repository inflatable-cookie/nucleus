# 206 Add Local Event Transport Backend Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add the first concrete local event transport backend boundary.

## Scope

- Name local transport identity and execution-host ownership.
- Define supported supervision event kinds.
- Keep delivery evidence separate from replay evidence.
- Keep the boundary in `nucleus-server`.

## Out Of Scope

- Remote event streaming.
- Process spawn.
- Runtime UI subscriptions.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Backend boundary compiles.
- Boundary can report readiness without spawning a process.
- Host-spawn readiness remains blocked by non-event descriptors.
