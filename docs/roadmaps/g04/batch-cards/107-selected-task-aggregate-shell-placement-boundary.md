# 107 Selected Task Aggregate Shell Placement Boundary

Status: superseded
Owner: Tom
Updated: 2026-07-09
Milestone: `../022-selected-task-aggregate-product-shell-placement.md`

## Purpose

Define the narrow product-shell placement for the selected-task aggregate before
adding UI markup.

## Work

- [x] Inspect the current product shell stage and project rail state.
- [x] Identify the selected task inputs the aggregate panel should consume.
- [x] Keep proof modal code untouched.
- [x] Document any placement constraint in the roadmap decision notes if needed.

## Acceptance Criteria

- [x] The workspace-stage implementation target is clear.
- [x] The aggregate helper is the only new selected-task data dependency.
- [x] No mutation controls or proof widgets are introduced.

## Result

Placed the selected-task aggregate in the existing right-side workspace-stage
panel, replacing the placeholder workflow copy without touching proof modal
code.

Superseded after operator correction. The normal workspace must stay empty
until the higher-level workflow is designed.
