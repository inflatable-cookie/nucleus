# 005 Selected Task Action Readiness

Status: completed
Owner: Tom
Updated: 2026-07-06

## Purpose

Add a server-owned read-only action readiness surface for the selected task.

The selected-task work-loop proof can now explain context and safe guidance.
This lane should explain which operator actions are allowed, blocked, or not
applicable before the UI offers or reshapes mutation controls.

## Governing Refs

- `docs/roadmaps/g04/004-selected-task-work-loop-composition.md`
- `docs/roadmaps/deferred-lanes.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Define selected-task action readiness without executing actions.
- [x] Add a server-owned read-only action readiness read model.
- [x] Expose readiness through CLI/Effigy for inspection.
- [x] Add a disposable desktop proof that can explain allowed and blocked
  actions.
- [x] Keep mutation, provider execution, SCM execution, active apply, and final
  UI design out of scope.
- [x] Choose the next product lane from evidence.

## Execution Plan

- [x] Batch 1: action readiness boundary and action taxonomy.
- [x] Batch 2: server read model and DTO shape.
- [x] Batch 3: CLI/Effigy inspection surface.
- [x] Batch 4: disposable desktop proof consumption.
- [x] Batch 5: validation and next lane selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/021-selected-task-action-readiness-boundary.md`
- `batch-cards/022-selected-task-action-readiness-read-model.md`
- `batch-cards/023-selected-task-action-readiness-cli-effigy.md`
- `batch-cards/024-selected-task-action-readiness-desktop-proof.md`
- `batch-cards/025-selected-task-action-readiness-validation-next-lane.md`

## Boundary

This lane may:

- classify selected-task actions as allowed, blocked, not applicable, or
  requires a different lane
- explain blockers and required evidence refs
- represent task transitions, delegation readiness, review readiness, and SCM
  handoff readiness as read-only affordance evidence
- consume existing selected-task drilldown, task state, readiness, work items,
  review refs, and handoff refs

This lane must not:

- execute task transitions
- delegate work or schedule agents
- review, accept, reject, complete, archive, or mutate tasks
- run providers or callbacks
- run SCM or forge mutation
- apply accepted memory or planning imports
- make final UI design commitments

## Initial Action Families

The first readiness map should cover:

- plan selected task
- start selected task
- block selected task
- complete selected task
- archive selected task
- prepare delegation
- inspect runtime evidence
- review work evidence
- prepare SCM handoff

These are affordance labels. They are not command invocations.

## Action Statuses

Initial statuses:

- `allowed`: the affordance can be shown from current evidence, but execution
  still requires a future admitted command
- `blocked`: the affordance lacks required evidence or authority
- `not_applicable`: the affordance does not make sense for the selected task's
  current state
- `different_lane`: another read-only lane should be inspected first, usually
  runtime, review, or SCM handoff evidence

## Read Model Shape

The first server read model is derived from `TaskWorkflowDrilldown`.

It includes:

- `readiness_id`
- `project_id`
- `task_id`
- ordered actions with family, status, label, reason, evidence refs, and
  blocker refs
- source counts for task, readiness, work items, active work, completed work,
  runtime evidence, completion refs, review refs, SCM handoff refs, and gaps
- blockers summarized from blocked actions
- no-effect flags proving that the model did not mutate task, provider, SCM,
  memory, planning, projection, agent scheduling, or UI state

## Inspection Surfaces

The first inspection surfaces are read-only:

- `nucleusd query selected-task-action-readiness --project <project-id> --task
  <task-id>`
- `effigy server:query:selected-task-action-readiness`

The output is intentionally affordance-oriented. It names action families,
statuses, blockers, counts, and no-effect flags. It does not expose raw
payloads or command authority.

## Desktop Proof

The disposable task workflow proof panel consumes selected-task action
readiness as a server-owned read model.

It shows allowed, blocked, different-lane, and not-applicable affordances as
text. It does not expose action buttons or mutate task, provider, SCM, memory,
planning, projection, scheduling, or UI authority state.

## Next Lane

The next lane is `006-selected-task-operator-action-gate.md`.

Reason: action readiness now explains what the user can do next, but the
product still needs a server-admitted boundary before any selected-task
operator controls can appear. The next lane should cover task-only command
admission first and leave provider execution, SCM handoff, delegation
scheduling, active apply, and final UI design deferred.

## Stop Conditions

Stop and replan if implementation requires:

- a mutating command handler
- provider execution
- SCM/forge mutation
- active memory or planning apply
- raw payload exposure
- final UI redesign
