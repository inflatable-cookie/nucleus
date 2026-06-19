# 227 Gap Index Health Rebaseline

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../052-health-reset-validation-and-next-runtime-lane.md`

## Purpose

Update implementation audit and gap indexes after health repair.

## Scope

- Update code health state.
- Keep remaining warnings visible.
- Do not hide unresolved runtime gaps.

## Acceptance Criteria

- Audit docs match current doctor output.
- Gap indexes point at the next product/runtime gate.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if docs would overstate health.
