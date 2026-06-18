# 140 Task Runtime Scheduler Admission

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../032-codex-task-runtime-admission-bridge.md`

## Purpose

Bind task work units to scheduler admission records.

## Scope

- Require task, adapter, command authority, and event metadata refs.
- Return accepted/rejected admission receipts.
- Keep runtime execution deferred.

## Acceptance Criteria

- Scheduler admission can accept a task work-unit request.
- Missing refs fail closed.
- Admission is not execution.

## Validation

- `cargo test -p nucleus-server scheduler`
- `cargo test -p nucleus-server task_agent`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if scheduler needs background worker behavior.
