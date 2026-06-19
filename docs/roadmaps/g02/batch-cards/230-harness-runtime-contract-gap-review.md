# 230 Harness Runtime Contract Gap Review

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../053-harness-runtime-rebaseline.md`

## Purpose

Review harness runtime contracts before the next provider implementation lane.

## Scope

- Compare adapter, session, timeline, receipt, native runtime, and task-backed
  workflow contracts.
- Update gap indexes where the contracts are stale.
- Do not implement provider behavior.

## Acceptance Criteria

- Harness runtime contract gaps are explicit.
- Any blocker is visible before code work starts.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if a missing contract would make implementation speculative.
