# 246 Define Command Diagnostics Client Read Model

Status: ready
Owner: Tom
Updated: 2026-06-17

## Goal

Define the client-side read model for command diagnostics.

## Scope

- List row fields.
- Detail fields.
- Empty and error states.
- Refresh expectations.
- Raw-output exclusion.

## Out Of Scope

- UI styling.
- Artifact payload retrieval.
- Streaming output.
- Command execution controls.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-architecture.md`

## Acceptance Criteria

- Clients know which fields to render.
- Clients know which fields are unavailable by design.
- The model maps directly from the command history DTO.
