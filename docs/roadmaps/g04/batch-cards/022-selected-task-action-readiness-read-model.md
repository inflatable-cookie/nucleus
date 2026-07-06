# 022 Selected Task Action Readiness Read Model

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../005-selected-task-action-readiness.md`

## Purpose

Add the server-owned selected-task action readiness read model.

## Work

- [x] Compose action readiness from selected task state, work-loop guidance,
  readiness, work items, review refs, and handoff refs.
- [x] Represent allowed, blocked, not applicable, and different-lane statuses.
- [x] Include blockers, evidence refs, and no-effect flags.
- [x] Add focused tests for identity filtering and no mutation.

## Acceptance Criteria

- [x] The read model explains which actions are safe to show.
- [x] The read model does not execute actions.
- [x] Sanitized refs are exposed without raw payloads.

## Result

Added `selected_task_action_readiness` as a server-owned read model layered on
`TaskWorkflowDrilldown`.

The model exposes:

- ordered action families
- per-action status, reason, evidence refs, and blocker refs
- source counts for task, readiness, work, runtime, completion, review, SCM
  handoff, and gaps
- read-only no-effect flags

Focused tests cover delegation readiness, active work routing to runtime
inspection, completion/review/SCM readiness, and missing-task blocking without
mutation.
