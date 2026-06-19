# 218 Engine Management Sync Test Domain Split

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../049-engine-management-sync-test-split.md`

## Purpose

Split engine management sync tests by domain.

## Scope

- Separate validation, conflict, repair, capture, and Git dry-run tests.
- Keep assertions equivalent.

## Acceptance Criteria

- `management_sync/tests.rs` is below the error threshold.
- Capture and Git dry-run behavior remains covered.

## Validation

- `cargo test -p nucleus-engine management_sync`
- `cargo check --workspace`

## Stop Conditions

- Stop if the split requires production behavior changes.

## Result

Management sync tests are split by plan, repair, assistance, capture, Git
capture, and apply behavior.
