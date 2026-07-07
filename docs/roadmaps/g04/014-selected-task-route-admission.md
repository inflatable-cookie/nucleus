# 014 Selected Task Route Admission

Status: active
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

- [ ] Define the route-admission boundary and stop conditions.
- [ ] Add server-owned completion admission for accepted review outcomes.
- [ ] Shape rework and delegation admission without implementing full
  scheduling.
- [ ] Expose admission inspection through CLI, Effigy, and disposable desktop
  proof surfaces.
- [ ] Validate the lane and choose whether to implement completion apply,
  rework work-item creation, delegation scheduling, or SCM handoff review next.

## Execution Plan

- [ ] Batch 1: route-admission boundary, source refs, and effect rules.
- [ ] Batch 2: accepted-review completion admission read model.
- [ ] Batch 3: rework and delegation admission shape.
- [ ] Batch 4: CLI, Effigy, and desktop proof inspection.
- [ ] Batch 5: validation and next-phase selection.

## Batch Cards

Ready cards:

- `batch-cards/065-selected-task-route-admission-boundary.md`

Planned cards:

- `batch-cards/066-selected-task-completion-admission-read-model.md`
- `batch-cards/067-selected-task-rework-delegation-admission-shape.md`
- `batch-cards/068-selected-task-route-admission-surfaces.md`
- `batch-cards/069-selected-task-route-admission-validation.md`

Completed cards:

- None.

## Boundary

This lane may:

- inspect selected-task review outcome routes
- inspect selected-task command admission rules
- compute whether a route candidate may enter a task lifecycle admission flow
- expose dry-run admissions and refusal reasons
- show downstream command families and evidence refs
- reuse existing task command admission primitives where they fit

This lane must not:

- auto-complete, block, archive, reassign, or delegate a task from a route
- create branches, worktrees, commits, snapshots, pushes, PRs, publications, or
  merges
- schedule providers or agents
- apply memory, planning imports, projection writes, or SCM handoff mutations
- let desktop state decide admission authority
- present route admission as final UI

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
