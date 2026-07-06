# 027 Selected Task Operator Action Gate Read Model

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../006-selected-task-operator-action-gate.md`

## Purpose

Add the server-owned selected-task operator action gate read model.

## Work

- [x] Compose command candidates from selected-task action readiness.
- [x] Include expected revision posture, reason requirements, blockers, and
  evidence refs.
- [x] Prove the model does not execute task commands.
- [x] Add focused tests for allowed, blocked, and deferred actions.

## Acceptance Criteria

- [x] Task-only candidates are explicit.
- [x] Non-task actions stay read-only or deferred.
- [x] No command execution is introduced.

## Result

Added `selected_task_operator_action_gate`, a server-owned read-only gate over
selected-task action readiness.

The gate emits task command candidates only for start, block, complete, and
archive. It records expected revision posture, reason requirements, evidence
refs, blocker refs, and no-effect flags. It does not admit or execute commands.
