# 050 Management Projection Apply Import Split

Status: planned
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-server/src/management_projection_state/apply_import.rs`
into focused implementation and test modules.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/implementation-audit.md`

## Goals

- [ ] Separate apply report building, block classification, and state mutation
      helpers.
- [ ] Split local tests away from implementation where useful.
- [ ] Keep projection apply behavior unchanged.

## Execution Plan

- [ ] Module batch: split implementation helpers.
- [ ] Test batch: split apply/import unit tests.
- [ ] Validation batch: run scoped server tests.

## Batch Cards

Ready cards:

- None.

Planned cards:

- `batch-cards/220-management-projection-apply-import-module-split.md`
- `batch-cards/221-management-projection-apply-import-test-split.md`
- `batch-cards/222-management-projection-apply-import-validation.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] `apply_import.rs` is below the error threshold.
- [ ] Apply blocks, receipts, and revision gates still pass tests.
- [ ] No projection authority behavior changes.

## Gate

Do not broaden projection apply scope.
