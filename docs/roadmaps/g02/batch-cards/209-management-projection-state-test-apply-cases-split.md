# 209 Management Projection State Test Apply Cases Split

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../046-management-projection-state-test-split.md`

## Purpose

Split management projection state test cases by behavior.

## Scope

- Separate import staging, apply success, blocking, and receipt tests.
- Keep production code unchanged unless module wiring needs adjustment.

## Acceptance Criteria

- `management_projection_state/tests.rs` is below the god-file error threshold.
- Test coverage remains equivalent.

## Validation

- `cargo test -p nucleus-server management_projection_state`
- `cargo check --workspace`

## Stop Conditions

- Stop if a test split exposes ambiguous production behavior.

## Result

Export, import staging, and apply/import cases are split into focused test
modules.
