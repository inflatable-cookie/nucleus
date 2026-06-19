# 222 Management Projection Apply Import Validation

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../050-management-projection-apply-import-split.md`

## Purpose

Validate the management projection apply/import split.

## Scope

- Run scoped server tests.
- Check god-file report for `apply_import.rs`.
- Advance to change-request prep split.

## Acceptance Criteria

- Scoped server tests pass.
- `apply_import.rs` is no longer an error finding.

## Validation

- `cargo test -p nucleus-server management_projection_state`
- `cargo check --workspace`
- `effigy doctor`
- `git diff --check`

## Stop Conditions

- Stop if projection authority changes.

## Result

`cargo test -p nucleus-server management_projection_state` and `cargo check
--workspace` pass. `effigy doctor` god-file errors dropped from two to one.
