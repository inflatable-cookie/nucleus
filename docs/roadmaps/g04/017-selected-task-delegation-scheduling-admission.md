# 017 Selected Task Delegation Scheduling Admission

Status: paused
Owner: Tom
Updated: 2026-07-07

## Purpose

Turn selected-task delegation from a deferred preview into an explicit
server-owned scheduling admission path.

This lane may create or preview the first scheduled work-item record shape for
a selected task. It must not start provider execution, invoke Codex, mutate
SCM/forge state, publish projections, or make the desktop proof final UI.

## Pause Note

Paused after Batch 1 because the disposable proof UI has reached its useful
limit as an integration harness. Delegation scheduling remains valid, but
implementation should resume only after the first real product workflow UI
architecture is defined.

## Governing Refs

- `016-selected-task-rework-from-review-outcome.md`
- `014-selected-task-route-admission.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`

## Goals

- [x] Define the selected-task delegation scheduling boundary and authority map.
- [ ] Compose a server-owned admission model for scheduled work-item creation.
- [ ] Keep provider/runtime execution, live harness writes, SCM/forge mutation,
  memory apply, planning apply, task completion, and final UI out of scope.
- [ ] Expose the admission path through control, CLI, Effigy, and the
  disposable desktop proof.
- [ ] Validate that scheduled work-item admission is idempotent,
  revision-guarded, and provenance-backed.

## Execution Plan

- [x] Batch 1: boundary, authority, and stop-condition map.
- [ ] Batch 2: pure admission model for scheduled work-item creation.
- [ ] Batch 3: control, CLI, and Effigy inspection.
- [ ] Batch 4: disposable desktop proof integration.
- [ ] Batch 5: validation and next-lane selection.

## Batch Cards

Ready cards:

- none

Planned cards:

- `batch-cards/081-selected-task-delegation-work-item-admission.md`
- `batch-cards/082-selected-task-delegation-control-surfaces.md`
- `batch-cards/083-selected-task-delegation-desktop-proof.md`
- `batch-cards/084-selected-task-delegation-validation-next-lane.md`

Completed cards:

- `batch-cards/080-selected-task-delegation-scheduling-boundary.md`

## Boundary

This lane may:

- inspect selected-task identity, route-admission, rework preparation, action
  readiness, and operator-gate evidence
- admit a scheduled work-item shape when task, revision, adapter/provider
  readiness, operator intent, and idempotency inputs are valid
- report refusal reasons when scheduling is blocked
- preserve source refs from review, rework, route, task, and readiness records
- expose read-only preview surfaces before any later apply command

This lane must not:

- start provider/runtime execution
- invoke Codex or another harness
- write provider stdin/stdout, retain raw provider payloads, or expose secrets
- mutate SCM or forge state
- complete, archive, or accept a task
- accept, reject, or repair a work item result
- apply memory or planning records
- publish management projections
- treat desktop UI as state authority
- become final UI

## Source Map

Allowed source records:

- selected task record
- selected task action-readiness record
- selected task operator-action gate record
- selected task route-admission record
- selected task rework-preparation record when the delegation follows
  rejected or needs-changes review
- task workflow drilldown record for active work-item conflict checks
- existing task work-item summaries and progress projections
- adapter/provider readiness refs when already available in the selected-task
  source records
- prior review, route, work-item, evidence, runtime receipt, checkpoint, and
  diff refs by reference only

Forbidden source records:

- raw provider transcripts
- raw terminal streams
- raw stdout or stderr
- raw tool payloads
- secrets or credential material
- client-local layout or modal state
- SCM or forge mutation receipts as authority for scheduling
- management projection files as live task-agent state

The admission model should prefer existing selected-task read models over
fresh storage scans. If a required source is unavailable, the model should
return a refusal or explicit gap instead of synthesizing readiness.

## Authority Map

Engine/server authority:

- validate task and project identity
- validate expected task revision
- validate operator ref and idempotency key
- validate delegation readiness and source refs
- detect conflicting active work items
- compose scheduled work-item admission records
- return refusal reasons and no-effect flags

Client authority:

- choose the selected task
- submit operator intent
- render admission results
- refresh after admitted commands

Client non-authority:

- create work items directly
- start provider execution
- choose hidden provider sessions
- mutate task state without an admitted command
- import repo-backed projections as live orchestration state

Adapter/provider authority:

- none in this lane.

Adapters and providers may be named by readiness refs, but they must not be
called, started, resumed, cancelled, or written to.

## Required Inputs

The first pure model should accept:

- project id
- task id
- operator ref
- expected task revision
- idempotency key
- delegation source kind: action readiness, route admission, or rework
  preparation
- optional route admission id
- optional rework preparation id
- optional reviewed work-item refs
- optional reviewed evidence refs
- optional adapter/provider readiness refs when present

The model should derive candidate ids deterministically from task id,
delegation source, operator ref, and idempotency key. It should not allocate
opaque ids from wall-clock time during preview.

## Refusal Matrix

Initial refusal kinds:

- missing project id
- missing task id
- missing operator ref
- missing idempotency key
- stale task revision
- task not found
- project mismatch
- task mismatch
- delegation not ready
- unsupported source kind
- route admission missing
- route admission refused
- route admission mismatch
- rework preparation missing
- rework preparation refused
- rework preparation mismatch
- reviewed work-item refs missing when rework delegation requires them
- reviewed evidence refs missing when rework delegation requires them
- active conflicting work item
- adapter readiness missing
- provider readiness missing
- provider execution requested
- raw provider material requested
- SCM or forge mutation requested
- projection write requested

Refusals must fail closed and should preserve enough source refs for the
operator to understand the blocker.

## No-Effect Flags

The admission result must expose explicit no-effect flags.

Flags that must remain false in this lane:

- provider execution performed
- provider write performed
- Codex or harness invocation performed
- SCM mutation performed
- forge mutation performed
- memory apply performed
- planning apply performed
- projection write performed
- task completion performed
- task acceptance performed
- UI effect performed

The work-item creation posture should be separate from these flags:

- previewed: the result names the candidate scheduled work item
- admitted: a later explicit command may create the scheduled work item
- unavailable: inputs are insufficient or blocked

Card 081 may implement a read-only preview first. If it adds an admitted
command path, that path must still stop before provider execution.

## Admission Shape

The next model should be named as selected-task delegation scheduling
admission, not provider execution.

Required inputs:

- project id
- task id
- operator ref
- expected task revision
- route or readiness source refs
- idempotency key
- assignment target or adapter/provider readiness refs when available
- optional rework preparation ref when delegation follows rejected or
  needs-changes review

The model admits only when:

- selected task and project refs are present
- the expected task revision matches current task state where available
- operator ref and idempotency key are present
- task action readiness allows delegation or rework delegation
- route admission or rework preparation provides a delegation source
- no active conflicting work item blocks scheduling
- provider execution is not requested
- raw provider material is not requested

The output should include:

- admission id
- project id and task id
- candidate work-item id or preview ref
- source refs
- operator ref
- expected task revision
- admitted/refused status
- refusal kind and reason
- no-effect flags for provider, SCM/forge, memory, planning, projection, and UI
- explicit flags for whether work-item creation is previewed, admitted, or
  still unavailable

## Decision Notes

This is the right next lane because selected-task review can now branch to
accepted completion or rework preparation. The product workflow still lacks the
controlled transition from "this task should be delegated" to "a scheduled
work item exists." Provider execution should remain a later lane after
scheduled work-item admission is explicit and inspectable.
