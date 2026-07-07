# 013 Selected Task Review Outcome Routing

Status: active
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

- [ ] Define the post-review outcome-routing boundary, source refs, and
  no-effect rules.
- [ ] Add a read model that explains the next admissible route after a review
  decision.
- [ ] Expose the route through control DTOs, `nucleusd`, and Effigy.
- [ ] Show the route in the disposable desktop proof without final UI
  commitment.
- [ ] Validate the lane and decide whether the next implementation phase is
  task lifecycle admission, rework delegation, SCM handoff, or a planning
  checkpoint.

## Execution Plan

- [ ] Batch 1: boundary, route vocabulary, source map, and stop conditions.
- [ ] Batch 2: server read model for post-review route readiness.
- [ ] Batch 3: control DTOs, `nucleusd`, and Effigy inspection.
- [ ] Batch 4: disposable desktop proof presentation.
- [ ] Batch 5: lane validation and next-phase selection.

## Batch Cards

Ready cards:

- `batch-cards/060-selected-task-review-outcome-boundary.md`

Planned cards:

- `batch-cards/061-selected-task-review-outcome-read-model.md`
- `batch-cards/062-selected-task-review-outcome-cli-effigy.md`
- `batch-cards/063-selected-task-review-outcome-desktop-proof.md`
- `batch-cards/064-selected-task-review-outcome-validation.md`

Completed cards:

- None.

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
