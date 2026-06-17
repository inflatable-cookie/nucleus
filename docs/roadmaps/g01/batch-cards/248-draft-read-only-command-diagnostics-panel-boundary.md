# 248 Draft Read-Only Command Diagnostics Panel Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first disposable desktop command diagnostics panel boundary.

## Scope

- Read-only list/detail behavior.
- Status and rejection display.
- Artifact ref display.
- Refresh behavior.
- Boundaries between Rust-owned data and Svelte display state.

## Out Of Scope

- Final UI design.
- Commit/diff controls.
- Terminal or PTY views.
- Command execution buttons.

## Promotion Targets

- `docs/architecture/system-architecture.md`
- `apps/desktop/README.md`

## Acceptance Criteria

- The panel consumes the client read model.
- The panel does not become command authority.
- The UI can be thrown away without losing server behavior.

## Outcome

Architecture and desktop docs now define the command diagnostics panel as a
read-only, disposable Svelte surface over Rust-owned command history DTOs.
Allowed list/detail fields, refresh behavior, local view state, and forbidden
command/artifact/PTY controls are explicit.
