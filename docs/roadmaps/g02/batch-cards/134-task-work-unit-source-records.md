# 134 Task Work Unit Source Records

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../031-task-agent-work-unit-source-model.md`

## Purpose

Add source record types for task-backed agent work units.

## Scope

- Add stable work-unit identity.
- Add project, task, adapter, command, and actor refs.
- Add lifecycle state and provenance fields.
- Keep provider runtime execution absent.

## Acceptance Criteria

- Work-unit source records are typed and testable.
- Records do not encode Codex-only assumptions.
- No provider process starts.

## Validation

- `cargo test -p nucleus-engine task_agent`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if source records need unresolved lifecycle rules.
