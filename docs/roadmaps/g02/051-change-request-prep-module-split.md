# 051 Change Request Prep Module Split

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-engine/src/change_request_prep.rs` into focused type and
test modules.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/implementation-audit.md`

## Goals

- [x] Separate prep records, candidates, policy gates, descriptors, and
      evidence packages.
- [x] Split tests by behavior.
- [x] Preserve provider-neutral vocabulary.

## Execution Plan

- [x] Type batch: split change-request prep domains.
- [x] Test batch: split behavior tests.
- [x] Validation batch: run scoped engine tests.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/223-change-request-prep-type-split.md`
- `batch-cards/224-change-request-prep-test-split.md`
- `batch-cards/225-change-request-prep-validation.md`

## Acceptance Criteria

- [x] `change_request_prep.rs` is below the error threshold.
- [x] GitHub and Convergence-like prep assertions are preserved.
- [x] No forge/network behavior is added.

## Result

`change_request_prep.rs` is now a front door with candidate, descriptor,
evidence package, prep, target, and test modules. Scoped engine tests and
workspace check pass.

## Gate

Do not add live forge integration while splitting this module.
