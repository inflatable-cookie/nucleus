# 256 Define Runtime Readiness Diagnostics Read Model

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the client read model for runtime readiness diagnostics.

## Scope

- Host id.
- Runtime surface.
- Readiness status.
- Blockers.
- Evidence refs.
- Sanitized repair hints.

## Out Of Scope

- Command execution.
- Artifact payload retrieval.
- Remote transport.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-architecture.md`

## Acceptance Criteria

- Clients know what readiness fields to render.
- Blocker fields are sanitized.
- Readiness does not imply command approval.

## Outcome

Defined `RuntimeReadinessDiagnostics` with host id, runtime surface, status,
sanitized blockers, evidence refs, repair hints, and summary.
