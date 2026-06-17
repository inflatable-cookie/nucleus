# 201 Add Local Artifact Store Backend Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add the first concrete local artifact-store backend boundary.

## Scope

- Name backend identity and state-root ownership.
- Define accepted first payload classes.
- Define retention and redaction evidence refs.
- Keep storage behavior separate from process execution.

## Out Of Scope

- Process spawn.
- Remote object storage.
- Artifact browser UI.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Backend boundary compiles.
- Boundary can report readiness without storing raw output.
- Host-spawn readiness remains blocked by other backend descriptors.
