# 228 Next Runtime Lane Readiness

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../052-health-reset-validation-and-next-runtime-lane.md`

## Purpose

Select the next runtime lane after the health gate.

## Scope

- Compare harness runtime, native steward depth, remote transport, workspace
  panels, and planning/memory/research.
- Mark one next card ready only if contracts are sufficient.

## Acceptance Criteria

- One next lane is selected or explicitly paused.
- Roadmap front doors have one clear next task.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if operator intent is needed before selecting the lane.
