# 161 Post Runtime Health Gate

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../036-task-backed-workflow-validation-and-next-lane.md`

## Purpose

Re-run health and QA after task-backed runtime proof work.

## Scope

- Run doctor, Rust, desktop, docs, and targeted tests.
- Record residual risks.
- Avoid broad speculative cleanup.

## Acceptance Criteria

- Health state is recorded.
- Blocking failures are fixed or rehomed.
- Warning pressure is named for touched areas.

## Validation

- `effigy doctor`
- `cargo test --workspace`
- `effigy desktop:check`
- `effigy desktop:build`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if doctor reports a new high finding.
