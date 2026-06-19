# 051 Change Request Prep Module Split

Status: active
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-engine/src/change_request_prep.rs` into focused type and
test modules.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/implementation-audit.md`

## Goals

- [ ] Separate prep records, candidates, policy gates, descriptors, and
      evidence packages.
- [ ] Split tests by behavior.
- [ ] Preserve provider-neutral vocabulary.

## Execution Plan

- [ ] Type batch: split change-request prep domains.
- [ ] Test batch: split behavior tests.
- [ ] Validation batch: run scoped engine tests.

## Batch Cards

Ready cards:

- `batch-cards/223-change-request-prep-type-split.md`

Planned cards:

- `batch-cards/224-change-request-prep-test-split.md`
- `batch-cards/225-change-request-prep-validation.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] `change_request_prep.rs` is below the error threshold.
- [ ] GitHub and Convergence-like prep assertions are preserved.
- [ ] No forge/network behavior is added.

## Gate

Do not add live forge integration while splitting this module.
