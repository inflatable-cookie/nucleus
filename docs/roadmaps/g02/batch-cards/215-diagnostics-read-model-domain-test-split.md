# 215 Diagnostics Read Model Domain Test Split

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../048-diagnostics-read-model-test-split.md`

## Purpose

Split diagnostics read-model tests by domain.

## Scope

- Separate steward, Effigy, sync, SCM, task, and control diagnostics tests.
- Preserve assertion coverage.

## Acceptance Criteria

- `diagnostics_read_models/tests.rs` is below the error threshold.
- Domain test modules remain readable.

## Validation

- `cargo test -p nucleus-server diagnostics_read_models`
- `cargo check --workspace`

## Stop Conditions

- Stop if diagnostics read models need behavior redesign.
