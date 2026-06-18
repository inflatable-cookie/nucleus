# 115 Effigy Diagnostics Source Records

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../027-diagnostics-read-model-source-integration.md`

## Purpose

Source Effigy diagnostics from available native harness or server records.

## Scope

- Read available Effigy integration, health, and validation-plan records.
- Return explicit missing/disabled state when absent.
- Do not run Effigy commands.

## Acceptance Criteria

- [x] Effigy diagnostics use available source records.
- [x] Missing or disabled state is explicit.
- [x] Query execution does not run selectors.

## Outcome

Effigy diagnostics now expose source status and summary. Disabled Effigy state
is serialized as `disabled`; populated read-model fixtures report `records`.

## Validation

- `cargo test -p nucleus-server effigy`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if source integration requires live Effigy execution.
