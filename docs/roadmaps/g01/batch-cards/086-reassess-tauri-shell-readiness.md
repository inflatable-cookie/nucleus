# 086 Reassess Tauri Shell Readiness

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Decide whether the desktop shell can start after the local control boundary is
testable.

## Scope

- Check whether project/task/workspace state can be consumed through server
  APIs.
- Check whether auth posture is clear enough for a local desktop client.
- Check whether event replay is enough for first activity indicators.
- Decide whether Tauri implementation starts next or another server slice is
  still blocking it.

## Out Of Scope

- Building the Tauri app.
- Selecting final UI framework details.
- Implementing panels.
- Implementing live subscriptions.

## Promotion Targets

- `apps/desktop/README.md`
- `docs/architecture/system-architecture.md`
- `docs/roadmaps/g01/README.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Decision

Do not scaffold Tauri yet.

The server has enough local state, auth readiness, replay metadata, and
scheduler admission vocabulary to define a client boundary, but not enough for
a real desktop shell. The missing piece is a local control request handler and
local transport choice.

## Closeout

Desktop remains a placeholder. The next lane should build server-local request
handling and transport readiness before UI scaffolding.
