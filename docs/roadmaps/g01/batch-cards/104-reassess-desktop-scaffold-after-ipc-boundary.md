# 104 Reassess Desktop Scaffold After IPC Boundary

Status: planned
Owner: Tom
Updated: 2026-06-16

## Goal

Decide whether the desktop shell can be scaffolded after IPC boundary proof.

## Scope

- Check module decomposition results.
- Check serialization readiness.
- Check IPC command boundary fixture coverage.
- Decide whether Tauri scaffolding starts next or needs another server runway.

## Out Of Scope

- Scaffolding Tauri.
- Implementing panels.
- Implementing live subscriptions.

## Promotion Targets

- `apps/desktop/README.md`
- `docs/roadmaps/g01/README.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- Desktop scaffold readiness is explicit.
- If ready, the next card scopes only shell bootstrap and no panels.
- If not ready, the blocker is documented and routed to the next server card.
