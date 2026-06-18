# 112 Desktop Diagnostics Loading Error States

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../026-desktop-diagnostics-proof-surface.md`

## Purpose

Make diagnostics loading, empty, unsupported, and error states explicit.

## Scope

- Add loading state.
- Add empty and unsupported state displays.
- Add error display for failed control queries.

## Acceptance Criteria

- [x] Loading and error states are visually distinct.
- [x] Empty diagnostics are not treated as failures.
- [x] Unsupported diagnostics are not treated as ready.

## Outcome

The proof panel distinguishes loading, error, unsupported, absent response, and
empty live-record states.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if state handling requires product UI decisions.
