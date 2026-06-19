# 216 Diagnostics Read Model Validation

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../048-diagnostics-read-model-test-split.md`

## Purpose

Validate the diagnostics read-model test split.

## Scope

- Run scoped server diagnostics tests.
- Check god-file report for the touched test file.
- Advance to engine management sync split.

## Acceptance Criteria

- Scoped diagnostics tests pass.
- The original diagnostics test file is no longer an error finding.

## Validation

- `cargo test -p nucleus-server diagnostics_read_models`
- `cargo check --workspace`
- `effigy doctor`
- `git diff --check`

## Stop Conditions

- Stop if validation reveals DTO authority leakage.

## Result

`cargo test -p nucleus-server diagnostics_read_models` and `cargo check
--workspace` pass. `effigy doctor` god-file errors dropped from four to three.
