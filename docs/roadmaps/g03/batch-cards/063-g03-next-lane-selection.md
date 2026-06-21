# 063 G03 Next Lane Selection

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../016-g03-health-validation-rebaseline.md`

## Purpose

Select the next G03 lane from validation and module-pressure evidence.

## Acceptance Criteria

- [x] Next lane is selected explicitly.
- [x] If code-health consolidation wins, the ready card names the boundary.
- [x] If runner persistence wins, the ready card names the storage/replay
  contract.
- [x] No implementation behavior is added.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
