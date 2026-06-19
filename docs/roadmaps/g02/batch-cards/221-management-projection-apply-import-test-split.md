# 221 Management Projection Apply Import Test Split

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../050-management-projection-apply-import-split.md`

## Purpose

Split local apply/import tests after implementation helpers move.

## Scope

- Move tests into focused module files.
- Keep stale revision, block, receipt, and successful apply coverage.

## Acceptance Criteria

- Tests stay focused by behavior.
- `apply_import.rs` remains below the error threshold.

## Validation

- `cargo test -p nucleus-server management_projection_state`
- `cargo check --workspace`

## Stop Conditions

- Stop if tests reveal a real behavior defect that should be fixed separately.
