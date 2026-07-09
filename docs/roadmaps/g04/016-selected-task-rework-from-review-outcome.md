# 016 Selected Task Rework From Review Outcome

Status: completed
Owner: Tom
Updated: 2026-07-07

## Purpose

Turn a rejected or needs-changes review outcome into an explicit server-owned
rework preparation path.

The previous lane closed the accepted-review happy path as a read-only
completion preview. This lane handles the next branch: review evidence that
requires rework. It should produce or preview a new or repaired work-item
preparation record with provenance back to the reviewed work, without
scheduling an agent or starting provider execution.

## Governing Refs

- `013-selected-task-review-outcome-routing.md`
- `014-selected-task-route-admission.md`
- `015-selected-task-completion-from-route-admission.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`

## Goals

- [x] Define the rework-from-review apply boundary and stop conditions.
- [x] Reuse selected-task route admission evidence instead of inventing a new
  review authority.
- [x] Compose a server-owned rework preparation model with provenance refs.
- [x] Expose the rework preparation path through control, CLI, Effigy, and the
  disposable proof modal.
- [x] Keep delegation scheduling, provider execution, SCM/forge mutation,
  memory apply, planning apply, task completion, and final UI out of scope.

## Execution Plan

- [x] Batch 1: rework-from-review boundary and authority map.
- [x] Batch 2: pure server rework preparation composition.
- [x] Batch 3: control, CLI, and Effigy inspection.
- [x] Batch 4: disposable desktop proof integration.
- [x] Batch 5: validation and next-lane selection.

## Batch Cards

Ready cards:

- none

Planned cards:

- none

Completed cards:

- `batch-cards/075-selected-task-rework-route-apply-boundary.md`
- `batch-cards/076-selected-task-rework-work-item-composition.md`
- `batch-cards/077-selected-task-rework-control-surfaces.md`
- `batch-cards/078-selected-task-rework-desktop-proof.md`
- `batch-cards/079-selected-task-rework-validation-next-lane.md`

## Boundary

This lane may:

- inspect selected-task review outcome route evidence
- require admitted rework route preview state
- require rejected or needs-changes review decision refs
- preserve reviewed work-item refs and evidence refs
- compose a new or repaired work-item preparation record
- expose read-only diagnostics and preview controls

This lane must not:

- schedule an agent
- start provider/runtime execution
- mutate SCM, forge, memory, or planning state
- complete or archive the parent task
- overwrite prior runtime or review evidence
- treat desktop UI as state authority
- become final UI

## Rework Preparation Model

The next model should be named as a rework preparation preview, not a rework
executor.

Required inputs:

- project id
- task id
- operator ref
- route admission id
- review decision ref
- reviewed work-item refs
- reviewed evidence refs
- expected task revision when available
- expected reviewed work-item revision when available

The model admits only when:

- project and task match the selected route admission
- the rework/delegation route admission id matches the selected route admission
- the admitted route candidate is `ReadyForReworkAdmission`
- the review decision outcome is rejected or needs changes
- review decision ref is present
- reviewed evidence refs are present and belong to the admitted route
- at least one reviewed work-item ref is present
- stale task/work-item state and planning ambiguity blockers are absent
- operator ref is present

The model refuses without side effects when any of those checks fail.

The output should include:

- preparation id
- project id and task id
- route admission id and route id
- review decision ref
- reviewed work-item refs
- reviewed evidence refs
- admitted/refused status
- refusal kind and reason
- no-effect flags
- a candidate rework summary suitable for later operator review

No-effect flags must make these false:

- task lifecycle mutation
- work-item creation
- delegation scheduling
- provider/runtime execution
- provider write
- SCM/forge mutation
- memory apply
- planning apply
- projection write
- UI effect

## Decision Notes

Rework is the next bounded branch after accepted-review completion because it
uses the same route-admission evidence chain and closes a real product gap:
operator review can say "needs changes" without losing provenance.

Delegation scheduling should follow only after rework preparation can describe
what would be delegated. SCM handoff review should follow only after task work
outcomes and rework branches are coherent.

## Closeout

Rework preparation now provides that delegation handoff point. The lane stays
read-only and provenance-preserving: it does not create work items, schedule
agents, run providers, mutate SCM/forge state, apply memory/planning changes,
or become final UI.

Next lane: `017-selected-task-delegation-scheduling-admission.md`.
