# 220 Management Projection Apply Import Module Split

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../050-management-projection-apply-import-split.md`

## Purpose

Split management projection apply/import implementation helpers.

## Scope

- Separate block classification, applied-record building, and receipt/report
  assembly where useful.
- Preserve public module exports.

## Acceptance Criteria

- `apply_import.rs` is smaller and focused.
- Apply/import behavior is unchanged.

## Validation

- `cargo test -p nucleus-server management_projection_state`
- `cargo check --workspace`

## Stop Conditions

- Stop if helper movement changes apply authority behavior.

## Result

Apply/import batch orchestration remains in the front module. Record
preparation moved to `apply_import/prepare.rs`; receipt writing moved to
`apply_import/receipts.rs`.
