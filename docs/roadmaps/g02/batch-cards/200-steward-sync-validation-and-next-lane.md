# 200 Steward Sync Validation And Next Lane

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../043-steward-scm-sync-automation-gate.md`

## Purpose

Validate the steward SCM sync automation gate and choose the next workflow
checkpoint.

## Scope

- Run targeted steward sync tests.
- Run workspace-wide Rust checks.
- Run docs validation.
- Promote findings into gap indexes.

## Acceptance Criteria

- Steward sync authority and diagnostics are covered by tests.
- No autonomous provider mutation entered the lane.
- The next lane is explicit.

## Validation

- Targeted Rust tests for steward sync behavior.
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if validation shows steward authority leakage.
