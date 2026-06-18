# 138 Task Work Unit Source Validation

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../031-task-agent-work-unit-source-model.md`

## Purpose

Validate task work-unit source records and projections.

## Scope

- Run focused server/engine tests.
- Confirm no provider execution path is active.
- Advance to Codex runtime admission bridge.

## Acceptance Criteria

- [x] Source-model cards are complete or rehomed.
- [x] Work-unit read models are inspectable.
- [x] Next ready card points to Codex runtime admission bridge.

## Result

The source-model lane is complete. The next ready card is
`139-codex-task-runtime-request-records.md`.

## Validation

- `cargo test -p nucleus-engine`
- `cargo test -p nucleus-server diagnostics`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if source-model tests need runtime execution.
