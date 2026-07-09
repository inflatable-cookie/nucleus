# 105 Product Shell Task List Placement

Status: superseded
Owner: Tom
Updated: 2026-07-08
Milestone: `../021-product-shell-project-rail.md`

## Purpose

Decide and implement the first product-shell placement for task list and
selected-task stage.

## Work

- [x] Decide whether the task list lives beside or inside the central stage.
- [x] Add read-only task list consumption outside proof UI.
- [x] Keep selected-task detail shallow until aggregate query resumes.
- [x] Avoid duplicating the proof panel layout.

## Acceptance Criteria

- [x] Product task navigation exists outside the proof modal.
- [x] The implementation does not require the selected-task aggregate yet.
- [x] The next aggregate/query need is explicit.

## Result

Placed product task navigation inside the central project workspace stage.

`ProductTaskNavigator` consumes existing read-only task records, filters by the
active project, lets the user select a task, and shows a shallow selected-task
record. The proof task panels remain inside the proof harness.

The next query need is the paused selected-task aggregate: the product shell can
list and select tasks now, but richer work-loop/review/handoff state still needs
the aggregate lane before it belongs in the normal UI.

Superseded after operator correction. The product task navigation was removed
from the normal workspace; tasks should not be placed on screen until the
higher-level workflow is designed.

## Validation

- `effigy desktop:check`
