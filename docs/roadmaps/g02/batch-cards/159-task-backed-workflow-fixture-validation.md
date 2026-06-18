# 159 Task Backed Workflow Fixture Validation

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../036-task-backed-workflow-validation-and-next-lane.md`

## Purpose

Build and validate one complete task-backed workflow fixture.

## Scope

- Cover delegation, admission, progress, wait/review, receipts, and DTOs.
- Use fixtures only.
- Avoid provider execution and SCM mutation.

## Acceptance Criteria

- Fixture proves the task-backed workflow shape.
- Replay/read-model behavior is deterministic.
- No side effects run.

## Validation

- `cargo test -p nucleus-server task_agent`
- `cargo test -p nucleus-engine task_agent`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if the fixture needs live provider execution.
