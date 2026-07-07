# 006 Selected Task Operator Action Gate

Status: completed
Owner: Tom
Updated: 2026-07-06

## Purpose

Turn selected-task action readiness into a bounded operator action gate for
task-only actions.

The prior lane explains which affordances are allowed, blocked,
not-applicable, or in a different lane. This lane should decide which of those
affordances may become admitted task commands without letting the desktop
client become the state authority.

## Governing Refs

- `docs/roadmaps/g04/005-selected-task-action-readiness.md`
- `docs/roadmaps/deferred-lanes.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Define which selected-task actions can map to task-only commands.
- [x] Keep provider execution, SCM execution, delegation scheduling, active
  apply, and final UI out of scope.
- [x] Add a server-owned action gate or admission proof before desktop controls.
- [x] Expose the gate through CLI/Effigy for inspection.
- [x] Add disposable desktop proof consumption only after the server gate is
  stable.
- [x] Choose the next product lane from evidence.

## Execution Plan

- [x] Batch 1: action-to-command boundary and stop conditions.
- [x] Batch 2: server-owned action gate/read model.
- [x] Batch 3: CLI/Effigy inspection.
- [x] Batch 4: disposable desktop proof consumption.
- [x] Batch 5: validation and next lane selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/026-selected-task-operator-action-boundary.md`
- `batch-cards/027-selected-task-operator-action-gate-read-model.md`
- `batch-cards/028-selected-task-operator-action-cli-effigy.md`
- `batch-cards/029-selected-task-operator-action-desktop-proof.md`
- `batch-cards/030-selected-task-operator-action-validation-next-lane.md`

## Result

The lane now provides:

- selected-task action readiness
- server-owned operator action gate
- CLI and Effigy inspection
- disposable desktop proof consumption
- strict no-effect posture for provider, delegation, SCM/forge, review
  acceptance, active apply, and final UI

Next lane:

- `007-selected-task-command-admission-controls.md`

## Boundary

This lane may:

- map selected-task readiness actions to task-only command candidates
- use existing task transition command vocabulary where appropriate
- require expected revision, actor/client evidence, and reason fields
- expose allowed and blocked command candidates as read-only gate records
- add CLI/Effigy and disposable desktop proof consumption

This lane must not:

- start provider execution
- schedule delegation or agent work
- run SCM or forge mutation
- accept review evidence
- prepare or publish change requests
- apply memory or planning imports
- make final UI design commitments

## Initial Action Mapping

Candidate task-only mappings:

- `start_selected_task` -> task start transition candidate
- `block_selected_task` -> task block transition candidate with reason
- `complete_selected_task` -> task complete transition candidate
- `archive_selected_task` -> task archive transition candidate

Read-only or deferred mappings:

- `plan_selected_task` remains read-only until planning-session mutation is in
  scope
- `prepare_delegation` remains deferred until scheduling is in scope
- `inspect_runtime_evidence` remains read-only
- `review_work_evidence` remains deferred to review/acceptance controls
- `prepare_scm_handoff` remains deferred to SCM handoff controls

## Stop Conditions

Stop and replan if implementation requires:

- provider execution
- SCM/forge execution
- delegation scheduling
- review acceptance
- active memory or planning apply
- final UI design
- client-side state authority
