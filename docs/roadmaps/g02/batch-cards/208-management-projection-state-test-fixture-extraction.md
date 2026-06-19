# 208 Management Projection State Test Fixture Extraction

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../046-management-projection-state-test-split.md`

## Purpose

Extract shared fixtures from `management_projection_state/tests.rs`.

## Scope

- Create focused test helper modules under `management_projection_state`.
- Move builders without changing assertions.
- Preserve test names where practical.

## Acceptance Criteria

- Shared helpers are no longer mixed into the main test file.
- Existing management projection state tests still pass.

## Validation

- `cargo test -p nucleus-server management_projection_state`
- `cargo check --workspace`

## Stop Conditions

- Stop if helper extraction changes fixture semantics.

## Result

Shared imports and module wiring now live in the test index; domain cases moved
out of the original god-file.
