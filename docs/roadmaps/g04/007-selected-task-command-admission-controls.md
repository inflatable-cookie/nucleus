# 007 Selected Task Command Admission Controls

Status: completed
Owner: Tom
Updated: 2026-07-07

## Purpose

Turn server-owned selected-task operator action gate candidates into explicit,
operator-triggered task command admission controls.

The prior lane proved which selected-task affordances may become task-only
command candidates. This lane should prove the next bridge: an operator can act
on a task-only candidate and the server admits the existing task command shape
without letting the desktop become task state authority.

## Governing Refs

- `docs/roadmaps/g04/006-selected-task-operator-action-gate.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Define the admission boundary from gate candidate to task command.
- [x] Require explicit operator intent for task mutation.
- [x] Keep start, block, complete, and archive as the only admitted actions.
- [x] Preserve expected revision and block-reason requirements.
- [x] Add server/CLI evidence before any desktop proof control.
- [x] Add disposable desktop proof controls only after the server boundary is
  stable.
- [x] Validate that provider execution, delegation scheduling, SCM/forge
  mutation, review acceptance, and planning/memory apply remain out of scope.

## Execution Plan

- [x] Batch 1: candidate-to-command admission boundary.
- [x] Batch 2: server-owned admission proof over existing task commands.
- [x] Batch 3: CLI/Effigy inspection and focused task-command tests.
- [x] Batch 4: disposable desktop proof controls behind the server gate.
- [x] Batch 5: validation and next lane selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/031-selected-task-command-admission-boundary.md`
- `batch-cards/032-selected-task-command-admission-proof.md`
- `batch-cards/033-selected-task-command-cli-effigy.md`
- `batch-cards/034-selected-task-command-desktop-proof-controls.md`
- `batch-cards/035-selected-task-command-validation-next-lane.md`

## Boundary

This lane may:

- map gate task-command candidates to existing task transition commands
- require expected revision evidence before mutation
- require an operator-supplied reason for block
- submit only task-domain commands to the server boundary
- render disposable proof controls for task-only actions
- record command receipts and task timeline evidence

This lane must not:

- start provider execution
- schedule delegation or agent work
- run SCM or forge mutation
- accept review evidence
- mark provider work as task completion without explicit task command intent
- apply memory or planning imports
- make final UI design commitments
- let the desktop synthesize task state outside server command responses

## Initial Command Mapping

Allowed task-only mappings:

- `start_selected_task` -> existing task `start` command
- `block_selected_task` -> existing task `block` command with reason
- `complete_selected_task` -> existing task `complete` command
- `archive_selected_task` -> existing task `archive` command

Deferred or passive mappings:

- `plan_selected_task` remains read-only until planning-session mutation returns
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
- widening beyond start/block/complete/archive
