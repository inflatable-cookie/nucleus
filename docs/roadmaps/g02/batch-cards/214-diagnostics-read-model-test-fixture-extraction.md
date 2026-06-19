# 214 Diagnostics Read Model Test Fixture Extraction

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../048-diagnostics-read-model-test-split.md`

## Purpose

Extract shared diagnostics read-model test fixtures.

## Scope

- Move shared builders into focused test helper modules.
- Keep diagnostics DTO behavior unchanged.

## Acceptance Criteria

- Shared setup is not duplicated across split test modules.
- Existing diagnostics tests pass.

## Validation

- `cargo test -p nucleus-server diagnostics_read_models`
- `cargo check --workspace`

## Stop Conditions

- Stop if fixture extraction obscures DTO assertions.
