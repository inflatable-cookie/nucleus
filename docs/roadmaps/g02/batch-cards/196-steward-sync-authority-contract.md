# 196 Steward Sync Authority Contract

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../043-steward-scm-sync-automation-gate.md`

## Purpose

Define steward authority over SCM sync recommendations.

## Scope

- Clarify propose, prepare, request, and execute authority levels.
- Keep provider mutation outside steward autonomy.
- Update contracts or architecture where authority is unclear.

## Acceptance Criteria

- Steward sync authority is explicit and bounded.
- Mutating provider actions require later approval gates.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if steward authority cannot be bounded without operator input.
