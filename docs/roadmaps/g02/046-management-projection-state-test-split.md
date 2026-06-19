# 046 Management Projection State Test Split

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-server/src/management_projection_state/tests.rs` into
smaller focused test modules without changing behavior.

## Governing Refs

- `docs/architecture/implementation-audit.md`
- `docs/roadmaps/g02/045-god-file-health-gate-rebaseline.md`

## Goals

- [x] Extract shared fixtures.
- [x] Split apply/import cases by behavior.
- [x] Keep tests green.

## Execution Plan

- [x] Fixture batch: move helpers out of the god-file test module.
- [x] Case batch: split apply/import tests into focused modules.
- [x] Validation batch: run scoped server tests and workspace check.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/208-management-projection-state-test-fixture-extraction.md`
- `batch-cards/209-management-projection-state-test-apply-cases-split.md`
- `batch-cards/210-management-projection-state-test-validation.md`

## Acceptance Criteria

- [x] The original test god file is below the error threshold.
- [x] No test behavior is removed.
- [x] Scoped server tests pass.

## Result

`management_projection_state/tests.rs` is now a 21-line test module index with
domain test modules for export, import staging, and apply/import behavior.
`cargo test -p nucleus-server management_projection_state` passes.

## Gate

Do not rewrite management projection behavior while splitting tests.
