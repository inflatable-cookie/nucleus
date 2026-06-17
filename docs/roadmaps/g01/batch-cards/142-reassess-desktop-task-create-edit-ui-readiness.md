# 142 Reassess Desktop Task Create Edit UI Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Decide whether desktop task create/edit UI can be planned.

## Scope

- Check authoring input contract.
- Check create/update command DTO support.
- Check server execution.
- Check validation and revision conflict surfaces.

## Out Of Scope

- Implementing create/edit UI.
- Assignment UI.
- Runtime execution.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- [x] Create/edit UI readiness is explicit.
- [x] Missing authority remains visible if still blocked.

## Result

Desktop task create/edit UI is intentionally deferred. The current desktop is
a disposable proof control plane for server functions, not the product UI
direction.

Server task create/update authority now exists, so the next lane should build
the server runtime surface instead of adding more desktop panels.
