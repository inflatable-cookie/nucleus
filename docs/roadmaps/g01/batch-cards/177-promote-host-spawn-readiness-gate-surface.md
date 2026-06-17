# 177 Promote Host Spawn Readiness Gate Surface

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Promote the host-spawn readiness gate surface into the server boundary
contract.

## Scope

- Document readiness gate responsibilities.
- Document blocker categories.
- Document non-spawning rule.

## Out Of Scope

- Child process spawning.
- Runtime implementation details.
- Desktop UI.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Contract names readiness gate surface.
- Contract keeps real spawn blocked until gate passes.
- Contract remains backend-agnostic.

## Closeout

- Promoted host-spawn readiness gate responsibilities into the server boundary
  contract.
- Documented blocker categories and non-spawning rule.
- Kept real process spawning blocked until concrete sandbox, artifact store,
  event transport, and process-control backends exist.
