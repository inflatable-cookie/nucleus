# 013 Selected Task Review Outcome Routing

Status: completed
Owner: Tom
Updated: 2026-07-07

## Purpose

Route selected-task review decisions toward the next server-owned action
without collapsing review acceptance into task completion or letting clients
infer lifecycle state.

Roadmap 012 proved that an operator can accept, reject, request changes, or
abandon a selected-task review through the same server boundary across CLI,
Effigy, and the disposable desktop proof. This lane decides what those outcomes
mean next. It should expose completion-readiness, rework-readiness, delegation
readiness, and blocked/planning ambiguity as explicit outcomes, not hidden
client behavior.

## Governing Refs

- `docs/roadmaps/g04/012-selected-task-review-decision-controls.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Define the post-review outcome-routing boundary, source refs, and
  no-effect rules.
- [x] Add a read model that explains the next admissible route after a review
  decision.
- [x] Expose the route through control DTOs, `nucleusd`, and Effigy.
- [x] Show the route in the disposable desktop proof without final UI
  commitment.
- [x] Validate the lane and decide whether the next implementation phase is
  task lifecycle admission, rework delegation, SCM handoff, or a planning
  checkpoint.

## Execution Plan

- [x] Batch 1: boundary, route vocabulary, source map, and stop conditions.
- [x] Batch 2: server read model for post-review route readiness.
- [x] Batch 3: control DTOs, `nucleusd`, and Effigy inspection.
- [x] Batch 4: disposable desktop proof presentation.
- [x] Batch 5: lane validation and next-phase selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/060-selected-task-review-outcome-boundary.md`
- `batch-cards/061-selected-task-review-outcome-read-model.md`
- `batch-cards/062-selected-task-review-outcome-cli-effigy.md`
- `batch-cards/063-selected-task-review-outcome-desktop-proof.md`
- `batch-cards/064-selected-task-review-outcome-validation.md`

## Boundary

This lane may:

- inspect selected-task review-decision records
- inspect selected-task review/next-step state
- inspect task lifecycle state, task revision, task command receipts, runtime
  receipt refs, review evidence refs, and SCM handoff readiness
- compute next route readiness for accepted, rejected, needs-changes, and
  abandoned review outcomes
- expose route blockers, required operator choices, and downstream command
  candidates
- present route readiness through server-owned DTOs, CLI, Effigy, and
  disposable desktop proof surfaces

This lane must not:

- complete, archive, start, pause, or block tasks
- schedule providers or agents
- create branches, worktrees, commits, snapshots, pushes, PRs, publications, or
  merges
- apply memory, planning imports, or projection writes
- infer route authority from desktop state
- store raw provider payloads, raw command output, terminal streams, secrets, or
  private notes
- harden the disposable proof into final UI

## Route Vocabulary

Initial route candidates:

- `ready_for_completion_admission`
- `ready_for_rework_admission`
- `ready_for_delegation_admission`
- `ready_for_scm_handoff_review`
- `blocked_on_operator_choice`
- `blocked_on_missing_evidence`
- `blocked_on_stale_task_state`
- `blocked_on_planning_ambiguity`
- `no_review_decision`

The route is diagnostic. It does not mutate task lifecycle state. Later lanes
may turn route candidates into explicit admission commands.

## Decision Mapping

The first read model maps review decisions this way:

- `accepted` routes to `ready_for_completion_admission` when review evidence is
  still present and the selected-task review state agrees with the persisted
  decision.
- `accepted` may also expose `ready_for_scm_handoff_review` as a downstream
  candidate when SCM handoff evidence already exists, but it must not create or
  publish SCM state.
- `rejected` routes to `ready_for_rework_admission`.
- `needs_changes` routes to `ready_for_rework_admission`.
- `abandoned` routes to `blocked_on_operator_choice` until a later task-domain
  command decides whether the task should be blocked, archived, replanned, or
  reassigned.
- no persisted review decision routes to `no_review_decision`.

The route is a pathway hint. It is not a command and must not mutate task
lifecycle, work-item review, SCM handoff, planning, memory, provider, or UI
state.

## Source Map

The route may use:

- selected-task review-decision ids, outcomes, work-item refs, reviewed
  evidence refs, receipt refs, timeline refs, and blockers
- selected-task review state, work-item refs, evidence refs, source counts, and
  gaps
- selected-task next-step category, next ref, summary, and rationale refs
- task workflow state exposed through the selected-task review/next read model
- SCM handoff refs only as downstream context after accepted review evidence

The route must not use:

- raw provider payloads
- raw command output
- terminal streams
- client-only local state
- SCM or forge provider responses that have not been admitted as sanitized refs
- planning or memory imports that have not been accepted by their own domain

## Blockers

Initial blockers:

- `missing_decision_record`: no persisted review-decision record exists for the
  selected task.
- `missing_review_evidence`: the decision or selected-task review has no
  reviewable evidence refs.
- `stale_task_state`: the persisted decision outcome and current selected-task
  review state do not agree.
- `unsupported_review_state`: the selected-task review state is not routable by
  this lane.
- `planning_ambiguity`: the selected-task next-step/pathway is missing or
  explicitly blocked.
- `downstream_command_not_defined`: the route names a future admission command
  that is not implemented in this lane.

Blockers explain why a route cannot advance. They do not repair state.

## Read Model Shape

The first pure read model should return:

- route id
- project id
- task id
- primary route candidate
- additional route candidates
- status: ready, blocked, stale, or missing
- decision ref
- work-item refs
- evidence refs
- downstream command hints
- blockers
- source counts
- no-effect flags

No-effect flags must explicitly state that the route did not mutate review
state, task lifecycle state, provider execution, SCM/forge state, memory,
planning, projections, agent scheduling, or UI state.
