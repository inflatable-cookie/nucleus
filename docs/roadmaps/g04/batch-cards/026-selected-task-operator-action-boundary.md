# 026 Selected Task Operator Action Boundary

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../006-selected-task-operator-action-gate.md`

## Purpose

Define the task-only operator action boundary before adding command gate code.

## Work

- [x] Confirm which selected-task action families can map to task-only
  commands.
- [x] Define which action families stay read-only or deferred.
- [x] Define required command candidate fields.
- [x] Define stop conditions for provider, SCM, delegation, review, active
  apply, final UI, and client authority.

## Acceptance Criteria

- [x] The next read model can be implemented without guessing.
- [x] The lane stays task-only.
- [x] Deferred lanes remain deferred.

## Result

Task-only command candidates are limited to:

- `start_selected_task`
- `block_selected_task`
- `complete_selected_task`
- `archive_selected_task`

Passive mappings:

- `plan_selected_task` stays read-only.
- `inspect_runtime_evidence` stays read-only.
- `prepare_delegation` stays deferred until scheduling is in scope.
- `review_work_evidence` stays deferred until review acceptance is in scope.
- `prepare_scm_handoff` stays deferred until SCM handoff controls are in scope.

Required candidate fields:

- action family
- readiness status
- gate disposition
- optional task command action
- task id
- expected revision posture
- reason requirement
- evidence refs
- blocker refs

Stop conditions remain provider execution, SCM or forge mutation, delegation
scheduling, review acceptance, active memory/planning apply, final UI, and
client-side state authority.
