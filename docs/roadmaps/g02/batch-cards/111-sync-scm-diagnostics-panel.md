# 111 Sync SCM Diagnostics Panel

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../026-desktop-diagnostics-proof-surface.md`

## Purpose

Render sync and SCM diagnostics in the disposable desktop proof UI.

## Scope

- Add management sync diagnostics display.
- Add SCM session diagnostics display.
- Preserve provider-neutral vocabulary.

## Acceptance Criteria

- Sync plan and conflict state is visible.
- SCM session mode, testability, and repair state are visible.
- Panel does not assume Git-only terms.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics require working-copy mutation.
