# 128 Health Reset Validation

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../029-health-and-module-boundary-reset.md`

## Purpose

Validate the health reset and advance to task-backed workflow contract work.

## Scope

- Run focused Rust, desktop, docs, and doctor gates.
- Record any residual health risks.
- Move the ready pointer to milestone 030.

## Acceptance Criteria

- [x] Health reset cards are complete or rehomed.
- [x] Doctor status is recorded.
- [x] Next ready card points to task-backed workflow contract reset.

## Result

`effigy doctor` now exits successfully. Residual god-file findings are warning
only: 33 warnings, 0 errors. The next lane can start, but new task-agent work
should not grow those warning-sized modules without a split plan.

## Validation

- `effigy doctor`
- `cargo check --workspace`
- `cargo test --workspace`
- `effigy desktop:check`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if doctor still fails on a high finding without a rehomed plan.
