# 081 Effigy Test Plan Summary Command

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../020-effigy-command-backed-inspection.md`

## Purpose

Map `effigy test --plan` evidence into validation-plan summaries.

## Scope

- Add validation-plan command summary records.
- Preserve planned-only semantics.
- Link selectors, receipt refs, and evidence refs.

## Acceptance Criteria

- A test plan can list selectors without claiming execution.
- Execution requires a separate command or Effigy receipt.
- Raw plan output is excluded from durable task history.

## Validation

- `cargo test -p nucleus-native-harness effigy`
- `cargo test -p nucleus-engine runtime_receipt`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if plan capture is treated as test execution.
