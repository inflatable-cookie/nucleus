# 164 Normalize Engine Host Authority Docs

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Normalize the top-level docs around engine-first host authority.

## Scope

- Update architecture and front-door language.
- Add or reference the engine host authority contract.
- Keep the current crate names intact.

## Out Of Scope

- Rust refactors.
- Protocol implementation.
- Tauri embedded host implementation.

## Promotion Targets

- `README.md`
- `docs/architecture/system-architecture.md`
- `docs/contracts/017-engine-host-authority-contract.md`

## Acceptance Criteria

- Server-first wording is removed from the main architecture front door.
- Host forms are named.
- Authority domains are named.

## Closeout

- Added `017-engine-host-authority-contract.md`.
- Updated README and system architecture to engine-first / host-flexible.
- Paused stale process-supervisor runtime lane.
