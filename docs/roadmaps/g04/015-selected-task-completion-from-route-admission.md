# 015 Selected Task Completion From Route Admission

Status: active
Owner: Tom
Updated: 2026-07-07

## Purpose

Turn an admitted selected-task completion route into an explicit server-owned
task completion path without letting review routing, route admission, or desktop
state complete a task implicitly.

Roadmap 014 proved route admission as a read-only surface. This lane should
connect the accepted-review completion route to the existing task-command
authority in a way that preserves expected-revision checks, operator intent,
receipt evidence, timeline refresh, and stale-client protection.

## Governing Refs

- `014-selected-task-route-admission.md`
- `012-selected-task-review-decision-controls.md`
- `007-selected-task-command-admission-controls.md`
- `008-task-command-outcome-coherence.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`

## Goals

- [x] Define the completion-from-route apply boundary.
- [x] Reuse selected-task command admission instead of inventing a second task
  lifecycle authority.
- [x] Add server-visible evidence that the completion came from a reviewed,
  admitted route.
- [ ] Expose the route-backed completion path through control surfaces.
- [ ] Keep rework, delegation, SCM handoff review, provider execution, memory
  apply, and planning apply out of scope.

## Execution Plan

- [x] Batch 1: completion-from-route boundary and stop conditions.
- [x] Batch 2: server command/admission composition.
- [ ] Batch 3: control, CLI, and Effigy inspection.
- [ ] Batch 4: disposable desktop proof control.
- [ ] Batch 5: validation and next-lane selection.

## Batch Cards

Ready cards:

- `batch-cards/072-selected-task-completion-route-control-surfaces.md`

Planned cards:

- `batch-cards/073-selected-task-completion-route-desktop-proof.md`
- `batch-cards/074-selected-task-completion-route-validation.md`

Completed cards:

- `batch-cards/070-selected-task-completion-route-apply-boundary.md`
- `batch-cards/071-selected-task-completion-route-command-composition.md`

## Composition Model

`selected_task_completion_route_apply` is a pure server model. It accepts
project id, task id, expected revision, operator ref, route admission id, review
decision ref, reviewed evidence refs, and a selected-task route admission
record.

It admits only when:

- project and task match the selected route admission
- operator ref is present and matches the command admission
- expected revision is present and matches the admitted complete command
- route admission id matches the selected route admission record
- completion route admission is admitted
- review decision ref matches the admitted completion route
- reviewed evidence refs are non-empty and present on the admitted route
- selected-task command admission is admitted
- the admitted command is `TaskCommand::Complete`

It refuses without executing anything when any of those checks fail.

## Boundary

This lane may:

- inspect selected-task route admission
- require an admitted completion route
- compose with existing selected-task command admission
- submit an explicit task complete command through the server boundary
- record route, review decision, evidence, command receipt, and timeline refs
- expose dry-run and apply evidence through CLI, Effigy, and disposable desktop
  proof surfaces

This lane must not:

- complete a task directly from review outcome routing
- complete a task directly from route admission without explicit operator apply
- bypass expected-revision checks
- infer completion from desktop state
- create rework items
- schedule agents or providers
- mutate SCM, forge, planning, or memory state
- become final UI

## Decision Notes

Completion-from-route is the next smallest product step after route admission.
It closes the accepted-review happy path while leaving harder branches deferred.

Rework creation, delegation scheduling, and SCM handoff review remain important
but have wider authority and runtime surfaces. They should resume only after the
completion path proves the route-admission apply pattern.
