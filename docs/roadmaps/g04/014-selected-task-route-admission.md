# 014 Selected Task Route Admission

Status: completed
Owner: Tom
Updated: 2026-07-07

## Purpose

Turn selected-task review outcome routes into explicit server-owned admission
surfaces without letting the desktop, CLI, or Effigy infer task lifecycle
mutation from route diagnostics.

Roadmap 013 proved that review outcomes can be routed toward completion,
rework, delegation, SCM handoff review, or operator choice. This lane defines
how those routes become admissible next actions. The first useful target is
accepted-review completion admission; rework, delegation, and SCM handoff
review should be shaped enough to avoid painting the model into a corner.

## Governing Refs

- `docs/roadmaps/g04/013-selected-task-review-outcome-routing.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Define the route-admission boundary and stop conditions.
- [x] Add server-owned completion admission for accepted review outcomes.
- [x] Shape rework and delegation admission without implementing full
  scheduling.
- [x] Expose admission inspection through CLI, Effigy, and disposable desktop
  proof surfaces.
- [x] Validate the lane and choose whether to implement completion apply,
  rework work-item creation, delegation scheduling, or SCM handoff review next.

## Execution Plan

- [x] Batch 1: route-admission boundary, source refs, and effect rules.
- [x] Batch 2: accepted-review completion admission read model.
- [x] Batch 3: rework and delegation admission shape.
- [x] Batch 4: CLI, Effigy, and desktop proof inspection.
- [x] Batch 5: validation and next-phase selection.

## Batch Cards

Ready cards:

No ready cards. This roadmap is complete.

Planned cards:

No planned cards. The next implementation lane is tracked in
`015-selected-task-completion-from-route-admission.md`.

Completed cards:

- `batch-cards/065-selected-task-route-admission-boundary.md`
- `batch-cards/066-selected-task-completion-admission-read-model.md`
- `batch-cards/067-selected-task-rework-delegation-admission-shape.md`
- `batch-cards/068-selected-task-route-admission-surfaces.md`
- `batch-cards/069-selected-task-route-admission-validation.md`

## Boundary

This lane may:

- inspect selected-task review outcome routes
- inspect selected-task command admission rules
- compute whether a route candidate may enter a task lifecycle admission flow
- expose dry-run admissions and refusal reasons
- show downstream command families and evidence refs
- reuse existing task command admission primitives where they fit
- define preview records for rework, delegation, and SCM handoff review

This lane must not:

- auto-complete, block, archive, reassign, or delegate a task from a route
- create branches, worktrees, commits, snapshots, pushes, PRs, publications, or
  merges
- schedule providers or agents
- apply memory, planning imports, projection writes, or SCM handoff mutations
- let desktop state decide admission authority
- present route admission as final UI

## Authority Model

Route admission is a server-owned read/admission surface. It answers whether a
review outcome route may be converted into a later explicit command preview.
It does not apply that command.

The route-admission model must preserve these separations:

- review decision records prove what the operator decided about work-item
  evidence
- review outcome routes explain the next pathway candidate
- route admission decides whether the pathway candidate is admissible as a
  dry-run next action
- task command apply still requires a separate server command with expected
  revision and operator intent
- rework, delegation, and SCM handoff review remain separate future apply
  lanes

Clients may render admission state and submit a later explicit command only
through an exposed server boundary. Clients must not infer task lifecycle state
from route status, review state, button state, cached task rows, or desktop
panel state.

## Source Refs

Route admission may read:

- selected-task review outcome route id, status, primary route, candidates,
  blockers, downstream command hints, source counts, and no-effect flags
- selected-task review-decision ids, outcomes, work-item refs, reviewed
  evidence refs, receipt refs, timeline refs, blockers, expected revision, and
  idempotency key
- selected-task review-next state, evidence refs, next-step category, next ref,
  rationale refs, and gaps
- current task id, project id, activity state, revision id, assignment state,
  and action type
- selected-task operator action gate candidates when mapping a route to an
  existing task command preview
- existing selected-task command admission refusal rules for task-only command
  previews

Route admission must not read:

- raw provider payloads
- raw command output
- terminal streams
- local desktop-only state
- SCM or forge provider responses not admitted as sanitized refs
- planning or memory imports not accepted by their own domain
- projected management files as live task-agent authority

## Completion Admission

Accepted-review completion admission is the first implementation target.

To admit a completion preview, all of these must be true:

- route status is `ready`
- primary route is `ready_for_completion_admission`
- decision outcome is `accepted`
- decision ref is present
- task id and project id match the selected task
- current task revision is present when the task command requires it
- accepted review evidence refs are present
- no route blocker is present except the temporary
  `downstream_command_not_defined` blocker while this lane is replacing that
  placeholder
- selected-task command admission can produce a `complete_selected_task`
  preview from a server-owned candidate

Completion admission must refuse when:

- no review decision exists
- review evidence is missing
- the route is stale
- the review outcome is rejected, needs-changes, abandoned, or unknown
- the route is blocked by planning ambiguity
- the task revision required by command admission is missing
- the selected-task command gate does not expose a completion candidate
- selected task ids or project ids do not match

Completion admission is not completion apply. It must not write task activity,
task history, timeline entries, runtime receipts, SCM state, projection files,
or UI state.

## Rework And Delegation Shape

Rejected and needs-changes review outcomes may produce rework readiness
previews. These previews explain why the task should not complete and what
future rework action is needed.

Rework preview may expose:

- route id
- decision ref and outcome
- prior work-item refs
- reviewed evidence refs
- rework reason summary
- suggested next action family: `prepare_rework`
- optional delegation candidate: `delegate_rework`
- blockers and source counts
- no-effect flags

Rework preview must not:

- create a new work item
- repair or reopen an existing work item
- schedule an agent
- reassign the task
- start provider execution
- mutate task lifecycle state

Delegation readiness may be surfaced only as a preview until the scheduling
contract and command boundary are active for this path.

## SCM Handoff Review Shape

Accepted review with SCM handoff refs may expose SCM handoff review readiness.
That readiness is not branch, worktree, commit, snapshot, publication, push, PR,
or merge authority.

SCM handoff review preview may expose:

- route id
- accepted decision ref
- SCM handoff refs
- work-item refs
- evidence refs
- suggested next action family: `review_scm_handoff`
- blockers and source counts
- no-effect flags

SCM handoff review preview must not call SCM or forge adapters, refresh forge
state, create change requests, publish snapshots, push, merge, or write
projection files.

## Abandoned Review Shape

Abandoned review outcomes remain blocked on explicit operator choice.

The route-admission model may explain allowed future choices, such as blocking
the task, archiving the task, replanning, or assigning follow-up work. It must
not choose one automatically. Any later task lifecycle action must go through
its own command admission and apply path.

## Reuse Versus New Shapes

Reuse existing selected-task command admission for:

- validating operator ref
- validating expected task revision
- mapping a server-owned completion candidate to the existing `complete` task
  command preview
- returning task-command refusal reasons where the route-admission model has
  already proved the route is accepted and current

Add a new route-admission shape for:

- binding the admission to a review outcome route
- explaining route-level blockers before command admission is attempted
- representing rework readiness
- representing delegation readiness
- representing SCM handoff review readiness
- preserving decision refs, route refs, and evidence refs across all outcomes

Do not overload selected-task command admission with rework, delegation, or SCM
handoff semantics. It is a task lifecycle command bridge, not a generic
workflow router.

## Admission Direction

Initial route-admission candidates:

- accepted review with current evidence may admit a `complete` task command
  preview
- rejected or needs-changes review may admit a rework preparation preview
- needs-changes review may also expose delegation readiness if later scheduling
  rules exist
- accepted review with SCM handoff evidence may expose SCM handoff review
  readiness
- abandoned review remains blocked on explicit operator choice

All outcomes remain dry-run/read-model state until a later lane implements an
apply command with receipts.

## No-Effect Rules

Route-admission records must explicitly report no effects for:

- review mutation
- task lifecycle mutation
- provider execution
- provider write
- SCM or forge mutation
- memory apply
- planning apply
- projection write
- agent scheduling
- UI state change

If any implementation needs one of those effects, it belongs in a later apply
lane, not this admission lane.

## Test-First Implementation Notes

The next implementation card should start with pure server tests for:

- accepted review admits completion preview
- missing decision refuses before command admission
- missing evidence refuses before command admission
- stale route refuses before command admission
- planning ambiguity refuses before command admission
- rejected and needs-changes route to rework preview, not completion
- abandoned route blocks on operator choice
- mismatched project or task refs refuse
- no-effect flags remain false

Only after the pure model passes should the lane add DTOs, `nucleusd`, Effigy,
or desktop proof wiring.
