# 112 Add Desktop Control Query Helpers

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Add small TypeScript helpers for the first supported read-only control queries.

## Scope

- Add helpers for runtime metadata list queries.
- Add helpers for project, task, and workspace list queries.
- Keep helpers as DTO constructors only.
- Keep query ids stable enough for UI diagnostics.

## Out Of Scope

- Client-side state authority.
- Mutation commands.
- Query caching.
- Live subscriptions.

## Promotion Targets

- `apps/desktop/src/lib/control.ts`
- `apps/desktop/README.md`
- `docs/roadmaps/g01/012-desktop-control-diagnostics-and-panel-foundation.md`

## Acceptance Criteria

- [x] Helpers cover runtime metadata and first state list query shapes.
- [x] Helpers do not parse or reinterpret server-owned payloads.
- [x] Diagnostics can choose between query shapes.

## Notes

- Added DTO helpers for runtime metadata actions and state list domains.
- Diagnostics can run artifact metadata, command evidence, projects, tasks, and
  workspaces queries.
- TypeScript still only constructs DTOs, invokes Tauri, and renders raw
  response envelopes.

## Validation

```sh
bun run check
bun run build
```
