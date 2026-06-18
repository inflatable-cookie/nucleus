# 140 Task Runtime Scheduler Admission

Status: completed
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

- [x] Scheduler admission can accept a task work-unit request.
- [x] Missing refs fail closed.
- [x] Admission is not execution.

## Result

Added `admit_codex_task_runtime_request`, which validates authority refs and
submits an inert `AgentSessionTurn` request to the scheduler without starting
provider execution.

## Validation

- `cargo test -p nucleus-server scheduler`
- `cargo test -p nucleus-server task_agent`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if scheduler needs background worker behavior.
