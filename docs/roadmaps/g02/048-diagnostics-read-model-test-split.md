# 048 Diagnostics Read Model Test Split

Status: planned
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-server/src/diagnostics_read_models/tests.rs` into focused
diagnostics test modules.

## Governing Refs

- `docs/architecture/implementation-audit.md`
- `docs/contracts/007-server-boundary-contract.md`

## Goals

- [ ] Extract shared diagnostics fixtures.
- [ ] Split steward, Effigy, sync, SCM, task, and control diagnostics tests.
- [ ] Keep diagnostics DTO behavior unchanged.

## Execution Plan

- [ ] Fixture batch: move shared test builders.
- [ ] Domain batch: split diagnostics tests by read-model domain.
- [ ] Validation batch: run scoped server diagnostics tests.

## Batch Cards

Ready cards:

- None.

Planned cards:

- `batch-cards/214-diagnostics-read-model-test-fixture-extraction.md`
- `batch-cards/215-diagnostics-read-model-domain-test-split.md`
- `batch-cards/216-diagnostics-read-model-validation.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] The diagnostics tests are below the error threshold.
- [ ] DTO assertions are preserved.
- [ ] Scoped diagnostics tests pass.

## Gate

Do not add new diagnostics features while splitting tests.
