# 049 Engine Management Sync Test Split

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-engine/src/management_sync/tests.rs` into smaller
management sync test modules.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/implementation-audit.md`

## Goals

- [x] Extract management sync test fixtures.
- [x] Split validation, conflict, capture, and Git dry-run cases.
- [x] Keep engine tests green.

## Execution Plan

- [x] Fixture batch: move shared builders.
- [x] Domain batch: split test cases by sync concern.
- [x] Validation batch: run scoped engine tests.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/217-engine-management-sync-test-fixture-extraction.md`
- `batch-cards/218-engine-management-sync-test-domain-split.md`
- `batch-cards/219-engine-management-sync-validation.md`

## Acceptance Criteria

- [x] The management sync tests are below the error threshold.
- [x] Capture and Git dry-run assertions are preserved.
- [x] Scoped engine tests pass.

## Result

Engine management sync tests are split into plan, repair, assistance, capture,
Git capture, and apply modules. Scoped engine tests and workspace check pass.

## Gate

Do not change management sync semantics during this split.
