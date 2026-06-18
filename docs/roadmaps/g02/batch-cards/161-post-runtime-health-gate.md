# 161 Post Runtime Health Gate

Status: completed
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

## Result

- Re-ran targeted task-backed workflow tests during implementation.
- Full closeout validation passed for `cargo test --workspace`,
  `effigy desktop:check`, `effigy desktop:build`, `effigy qa:docs`,
  `effigy qa:northstar`, single `## Next Task` placement, and
  `git diff --check`.
- `effigy doctor` still reports the known `scan.god-files` failure:
  36 findings total, 35 warnings, 1 error.
- No new runtime/provider failure was introduced by this lane.
