# 046 Management Projection State Test Split

Status: planned
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-server/src/management_projection_state/tests.rs` into
smaller focused test modules without changing behavior.

## Governing Refs

- `docs/architecture/implementation-audit.md`
- `docs/roadmaps/g02/045-god-file-health-gate-rebaseline.md`

## Goals

- [ ] Extract shared fixtures.
- [ ] Split apply/import cases by behavior.
- [ ] Keep tests green.

## Execution Plan

- [ ] Fixture batch: move helpers out of the god-file test module.
- [ ] Case batch: split apply/import tests into focused modules.
- [ ] Validation batch: run scoped server tests and workspace check.

## Batch Cards

Ready cards:

- None.

Planned cards:

- `batch-cards/208-management-projection-state-test-fixture-extraction.md`
- `batch-cards/209-management-projection-state-test-apply-cases-split.md`
- `batch-cards/210-management-projection-state-test-validation.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] The original test god file is below the error threshold.
- [ ] No test behavior is removed.
- [ ] Scoped server tests pass.

## Gate

Do not rewrite management projection behavior while splitting tests.
