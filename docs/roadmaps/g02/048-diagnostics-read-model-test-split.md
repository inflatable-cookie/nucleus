# 048 Diagnostics Read Model Test Split

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-server/src/diagnostics_read_models/tests.rs` into focused
diagnostics test modules.

## Governing Refs

- `docs/architecture/implementation-audit.md`
- `docs/contracts/007-server-boundary-contract.md`

## Goals

- [x] Extract shared diagnostics fixtures.
- [x] Split steward, Effigy, sync, SCM, task, and control diagnostics tests.
- [x] Keep diagnostics DTO behavior unchanged.

## Execution Plan

- [x] Fixture batch: move shared test builders.
- [x] Domain batch: split diagnostics tests by read-model domain.
- [x] Validation batch: run scoped server diagnostics tests.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/214-diagnostics-read-model-test-fixture-extraction.md`
- `batch-cards/215-diagnostics-read-model-domain-test-split.md`
- `batch-cards/216-diagnostics-read-model-validation.md`

## Acceptance Criteria

- [x] The diagnostics tests are below the error threshold.
- [x] DTO assertions are preserved.
- [x] Scoped diagnostics tests pass.

## Result

Diagnostics read-model tests are split by domain. Scoped diagnostics tests and
workspace check pass.

## Gate

Do not add new diagnostics features while splitting tests.
