# 138 Task Work Unit Source Validation

Status: planned
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

- Source-model cards are complete or rehomed.
- Work-unit read models are inspectable.
- Next ready card points to Codex runtime admission bridge.

## Validation

- `cargo test -p nucleus-engine`
- `cargo test -p nucleus-server diagnostics`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if source-model tests need runtime execution.
