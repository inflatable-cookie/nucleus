# 248 Draft Read-Only Command Diagnostics Panel Boundary

Status: planned
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
