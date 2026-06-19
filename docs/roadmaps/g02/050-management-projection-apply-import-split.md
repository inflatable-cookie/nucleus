# 050 Management Projection Apply Import Split

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-server/src/management_projection_state/apply_import.rs`
into focused implementation and test modules.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/implementation-audit.md`

## Goals

- [x] Separate apply report building, block classification, and state mutation
      helpers.
- [x] Split local tests away from implementation where useful.
- [x] Keep projection apply behavior unchanged.

## Execution Plan

- [x] Module batch: split implementation helpers.
- [x] Test batch: split apply/import unit tests.
- [x] Validation batch: run scoped server tests.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/220-management-projection-apply-import-module-split.md`
- `batch-cards/221-management-projection-apply-import-test-split.md`
- `batch-cards/222-management-projection-apply-import-validation.md`

## Acceptance Criteria

- [x] `apply_import.rs` is below the error threshold.
- [x] Apply blocks, receipts, and revision gates still pass tests.
- [x] No projection authority behavior changes.

## Result

`apply_import.rs` is now a front door with preparation and receipt modules.
Scoped management projection state tests and workspace check pass.

## Gate

Do not broaden projection apply scope.
