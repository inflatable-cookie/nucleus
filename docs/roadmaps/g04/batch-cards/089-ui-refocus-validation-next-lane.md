# 089 UI Refocus Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../018-product-workflow-ui-architecture-refocus.md`

## Purpose

Validate the UI refocus and choose the next bounded implementation lane.

## Work

- [x] Run docs and Northstar validation.
- [x] Confirm the disposable proof is frozen as diagnostic-only.
- [x] Confirm the selected-task workflow architecture is ready for
  implementation.
- [x] Choose the next lane: product shell, aggregate query, delegation
  scheduling, or another planning checkpoint.

## Acceptance Criteria

- [x] The root Next Task points to a ready card.
- [x] The next card does not widen proof UI by default.
- [x] Any paused delegation cards are either resumed intentionally or left
  clearly parked.

## Result

The next lane is `019-workspace-hosting-model-extraction.md`.

Reason: the selected-task product shell should not be implemented as a
one-off one-window Svelte layout. Nucleus already decided to adopt the
Loophole-inspired display/window/surface/region/panel model, with global
local client shell state and per-project panel rules. That model should be
implemented in `nucleus-workspaces` before final product shell work expands.

Delegation scheduling stays paused until the shell can present it in the real
workflow surface.
