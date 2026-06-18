# 109 Desktop Diagnostics Control Helper

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../026-desktop-diagnostics-proof-surface.md`

## Purpose

Add desktop-side control helpers for diagnostics queries.

## Scope

- Add TypeScript DTO shapes or helpers for diagnostics responses.
- Reuse existing control request path.
- Keep helper read-only.

## Acceptance Criteria

- [x] Desktop can request diagnostics.
- [x] Helpers do not expose mutation calls.
- [x] Unsupported responses are represented.

## Outcome

Added typed desktop diagnostics query helpers and result mapping in
`apps/desktop/src/lib/control.ts`.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if helper shape depends on final UI design.
