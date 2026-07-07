# 009 Selected Task Review Next Step Presentation

Status: completed
Owner: Tom
Updated: 2026-07-07

## Purpose

Make selected-task review state and next-step guidance visible without turning
the desktop into review authority.

The task-command outcome lane now shows that explicit task mutation can be
observed through refreshed server-owned evidence. The next product gap is what
the user does after runtime work produces reviewable evidence: understand
review readiness, see the evidence boundary, and see the pathway-backed next
step without accepting review evidence or completing tasks automatically.

## Governing Refs

- `docs/roadmaps/g04/008-task-command-outcome-coherence.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Define selected-task review and next-step presentation boundary.
- [x] Compose read-only review readiness from existing work-item, checkpoint,
  diff, validation, receipt, timeline, and review refs.
- [x] Keep review acceptance, task completion, provider execution, SCM/forge
  mutation, memory apply, planning apply, and final UI out of scope.
- [x] Expose the read model through server control, `nucleusd`, and Effigy.
- [x] Present the evidence boundary and pathway-backed next step in the
  disposable desktop proof surface.
- [x] Validate the lane and choose the next product workflow lane from g04
  runway evidence.

## Execution Plan

- [x] Batch 1: review/next-step presentation boundary.
- [x] Batch 2: server read model and no-effect proof.
- [x] Batch 3: CLI/Effigy inspection.
- [x] Batch 4: disposable desktop proof consumption.
- [x] Batch 5: validation and next lane selection.

## Batch Cards

Ready cards:

None.

Planned cards:

- None.

Completed cards:

- `batch-cards/040-selected-task-review-next-boundary.md`
- `batch-cards/041-selected-task-review-next-read-model.md`
- `batch-cards/042-selected-task-review-next-cli-effigy.md`
- `batch-cards/043-selected-task-review-next-desktop-proof.md`
- `batch-cards/044-selected-task-review-next-validation.md`

## Result

The lane proves selected-task review readiness and pathway-backed next-step
presentation across server read model, control DTOs, `nucleusd`, Effigy, and
the disposable desktop proof. It remains read-only: no review decision, task
completion, provider execution, SCM/forge mutation, memory apply, planning
apply, or final UI authority was added.

Next lane:

- `010-selected-task-scm-handoff-readiness.md`

## Boundary

This lane may:

- summarize selected-task review readiness
- show whether work evidence is not ready, awaiting review, accepted,
  rejected, needs changes, or abandoned
- show sanitized checkpoint, diff, receipt, validation, timeline, review, and
  work-item refs
- show why the next step is review, rework, task command, SCM handoff, or
  planning ambiguity
- expose read-only CLI/Effigy and desktop proof consumption

This lane must not:

- accept, reject, abandon, or request changes on review evidence
- complete, archive, or otherwise mutate a task
- start provider execution
- schedule delegation or agent work
- run SCM or forge mutation
- apply memory or planning imports
- create final UI design commitments
- let the desktop synthesize review or next-task state

## Stop Conditions

Stop and replan if implementation requires:

- review decision commands
- task transition commands
- live provider execution
- SCM/forge execution
- active memory or planning apply
- a new storage authority for review state
- client-side review or next-task authority
