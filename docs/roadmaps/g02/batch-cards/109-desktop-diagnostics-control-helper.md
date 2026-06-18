# 109 Desktop Diagnostics Control Helper

Status: ready
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

- Desktop can request diagnostics.
- Helpers do not expose mutation calls.
- Unsupported responses are represented.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if helper shape depends on final UI design.
