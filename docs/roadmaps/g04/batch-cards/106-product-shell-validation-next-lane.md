# 106 Product Shell Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-08
Milestone: `../021-product-shell-project-rail.md`

## Purpose

Validate the first product shell pass and choose the next lane.

## Work

- [x] Run desktop checks.
- [x] Run docs/Northstar checks.
- [x] Confirm proof harness remains diagnostic-only.
- [x] Choose next lane: selected-task aggregate, task list/detail, local layout
  persistence, or Aura config UI exploration.

## Acceptance Criteria

- [x] Root Next Task points to a ready card.
- [x] Product shell has a usable project rail and active project stage.
- [x] Aggregate work resumes only if it is the real blocker.

## Result

The first product shell pass validated the project rail and active project
stage. The read-only task navigation placement was later superseded and removed
from the normal workspace.

The next lane is the selected-task product aggregate. It is now the real blocker
for moving richer workflow/review/handoff state into the normal shell without
turning proof query composition into product UI.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
