# 261 Define Disposable Readiness Panel Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the read-only UI boundary for runtime readiness diagnostics.

## Scope

- Fields to render from the typed DTO.
- Empty, unsupported, error, and unexpected states.
- Forbidden controls.

## Out Of Scope

- Final UI design.
- Runtime repair controls.
- Command execution.

## Promotion Targets

- `apps/desktop/README.md`
- `docs/architecture/system-architecture.md`

## Acceptance Criteria

- The panel boundary is explicit before UI wiring.
- Runtime readiness remains read-only.

## Outcome

Panel renders typed readiness records, states, blockers, evidence refs, hints,
and summary only. Runtime control actions remain forbidden.
