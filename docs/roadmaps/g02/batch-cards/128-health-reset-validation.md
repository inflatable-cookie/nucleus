# 128 Health Reset Validation

Status: planned
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

- Health reset cards are complete or rehomed.
- Doctor status is recorded.
- Next ready card points to task-backed workflow contract reset.

## Validation

- `effigy doctor`
- `cargo check --workspace`
- `effigy desktop:check`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if doctor still fails on a high finding without a rehomed plan.
