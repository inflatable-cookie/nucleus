# 049 Engine Management Sync Test Split

Status: planned
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

- [ ] Extract management sync test fixtures.
- [ ] Split validation, conflict, capture, and Git dry-run cases.
- [ ] Keep engine tests green.

## Execution Plan

- [ ] Fixture batch: move shared builders.
- [ ] Domain batch: split test cases by sync concern.
- [ ] Validation batch: run scoped engine tests.

## Batch Cards

Ready cards:

- None.

Planned cards:

- `batch-cards/217-engine-management-sync-test-fixture-extraction.md`
- `batch-cards/218-engine-management-sync-test-domain-split.md`
- `batch-cards/219-engine-management-sync-validation.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] The management sync tests are below the error threshold.
- [ ] Capture and Git dry-run assertions are preserved.
- [ ] Scoped engine tests pass.

## Gate

Do not change management sync semantics during this split.
