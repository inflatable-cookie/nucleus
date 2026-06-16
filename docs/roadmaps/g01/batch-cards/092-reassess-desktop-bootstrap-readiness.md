# 092 Reassess Desktop Bootstrap Readiness

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Decide whether the Tauri desktop shell can start after local request handling
and transport readiness are defined.

## Scope

- Check request handler coverage.
- Check state query coverage.
- Check command receipt posture.
- Check local transport readiness.
- Decide whether desktop scaffolding starts next.

## Out Of Scope

- Scaffolding Tauri.
- Implementing panels.
- Implementing live subscriptions.
- Implementing provider adapters.

## Promotion Targets

- `apps/desktop/README.md`
- `docs/roadmaps/g01/README.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Decision

Do not scaffold Tauri yet.

The local request handler can process read-only state queries and command
receipts, and transport readiness vocabulary exists. The missing piece is a
concrete local transport/client boundary that can prove desktop-style request
and response behavior before UI scaffolding.

## Closeout

Desktop remains a placeholder. The next lane is local transport and desktop
bootstrap preparation, with no Tauri UI yet.
