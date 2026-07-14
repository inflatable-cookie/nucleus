# 163 Desktop Window Layout Flattening

Status: completed
Owner: Codex
Updated: 2026-07-13
Milestone: `../031-window-region-panel-simplification.md`
Auto-start next card: yes

## Objective

Flatten desktop persistence and rendering to one direct window layout.

## Governing Refs

- `../../../specs/archive/008-window-region-panel-simplification.md`
- `../../../contracts/006-workspace-layout-contract.md`

## Scope

1. Replace Surface arrays/selection with direct layout and regions.
2. Decode schema v1 only as migration input; write only the new schema.
3. Remove Surface tabs and create/rename/close/reorder controls.
4. Preserve all panel and region behavior.

## Acceptance Criteria

- workspace opens directly into regions
- old active Surface is flattened when a v1 config is loaded
- panel actions and split persistence use the direct config
- no Surface workspace UI vocabulary remains

## Validation

- focused Tauri workspace UI tests
- `effigy desktop:check`

## Evidence

- migration and default-config tests
- clean Svelte diagnostics

## Stop Conditions

- a working panel path depends on independent Surface lifecycle

## Next

Auto-start card 164.

## Outcome

- Schema v2 persists one primary window with direct layout and region records.
- Schema v1 selects its active Surface as migration input and writes only v2.
- Surface tabs and lifecycle controls are removed; panel behavior is retained.
