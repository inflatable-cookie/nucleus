# 110 Steward Effigy Diagnostics Panel

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../026-desktop-diagnostics-proof-surface.md`

## Purpose

Render steward and Effigy diagnostics in the disposable desktop proof UI.

## Scope

- Add compact read-only steward diagnostics display.
- Add compact read-only Effigy diagnostics display.
- Preserve empty and unsupported states.

## Acceptance Criteria

- [x] Steward proposal and command state is visible.
- [x] Effigy integration, health, and validation state is visible.
- [x] Panel cannot mutate state.

## Outcome

Added a disposable desktop diagnostics panel with read-only steward and Effigy
summaries.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if panel design becomes final UI work.
