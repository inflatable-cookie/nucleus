# 135 Task Delegation Work Unit Admission

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../031-task-agent-work-unit-source-model.md`

## Purpose

Connect task delegation commands to work-unit admission.

## Scope

- Admit delegation commands into work-unit source records.
- Preserve expected revision and task authority checks.
- Return receipts without starting provider runtime.

## Acceptance Criteria

- [x] Delegating a task creates or references a work unit.
- [x] Admission failures are explicit.
- [x] Provider execution remains deferred.

## Result

Task delegation now returns a work item plus an admission source record.
Provider execution stays deferred.

## Validation

- `cargo test -p nucleus-server task_transitions`
- `cargo test -p nucleus-engine task_agent`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if task delegation needs provider-specific input.
