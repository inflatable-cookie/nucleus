# 092 Window Planning Fallback Helpers

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../019-workspace-hosting-model-extraction.md`

## Purpose

Add deterministic window planning and display fallback helpers.

## Work

- [x] Add an input/output shape for resolving configured windows against
  available displays.
- [x] Resolve target display from primary plus fallback display ids.
- [x] Preserve stable window ordering.
- [x] Choose a primary host window deterministically.
- [x] Add tests for missing display, fallback display, no display, and
  geometry lookup behavior.

## Acceptance Criteria

- [x] Window planning behavior is pure and unit tested.
- [x] Renderer code does not invent display fallback semantics.
- [x] The first desktop shell can start with one planned window without
  blocking multi-window support.

## Result

Added `planning.rs` with pure window planning:

- `WindowPlanInput`
- `PlannedWindow`
- `WindowPlanOutput`
- `choose_display_id`
- `plan_windows`

The planner resolves target display from configured target plus fallbacks,
preserves stable window ordering, picks the first planned window as primary,
and derives one bounded fallback window only when no configured window can be
placed and a display is available.

## Validation

- `cargo fmt --all`
- `cargo test -p nucleus-workspaces`
- `cargo check -p nucleus-workspaces`
