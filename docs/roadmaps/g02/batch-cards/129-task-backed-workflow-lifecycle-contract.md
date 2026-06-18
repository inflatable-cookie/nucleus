# 129 Task Backed Workflow Lifecycle Contract

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../030-task-backed-agent-workflow-contract-reset.md`

## Purpose

Define the task-backed agent work-unit lifecycle before implementation.

## Scope

- Name lifecycle states and transitions.
- Bind states to task, session, receipt, and review surfaces.
- Keep provider-specific terms out of the generic lifecycle.

## Acceptance Criteria

- Lifecycle states are explicit.
- Invalid transitions are named.
- Provider-specific behavior is deferred to runtime binding.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if lifecycle state depends on unresolved provider semantics.
