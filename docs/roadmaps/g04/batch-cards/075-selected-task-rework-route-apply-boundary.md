# 075 Selected Task Rework Route Apply Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../016-selected-task-rework-from-review-outcome.md`

## Purpose

Define the boundary for turning an admitted rework route preview into a
server-owned rework preparation path.

## Work

- [x] Name required inputs: project id, task id, operator ref, route admission
  id, review decision ref, reviewed work refs, reviewed evidence refs, and
  expected task/work-item revision where available.
- [x] Define admitted and refused states for rework preparation.
- [x] Define no-effect flags for task lifecycle, provider/runtime, SCM/forge,
  memory, planning, delegation, and UI authority.
- [x] Keep the initial output as a pure preview/preparation model, not a
  mutating executor.

## Acceptance Criteria

- [x] Rework preparation cannot happen from route status alone.
- [x] Rework preparation requires rejected or needs-changes review evidence.
- [x] Prior work-item and review evidence provenance is mandatory.
- [x] Delegation scheduling and provider execution remain out of scope.

## Stop Conditions

- Stop if current contracts do not authorize a rework preparation record.
- Stop if implementation would need provider execution, task mutation, or SCM
  mutation before the boundary is written down.

## Result

The rework boundary is now defined in the roadmap milestone.

The next implementation card may add a pure server model for rework
preparation. That model must stay a preview/preparation record with mandatory
route, review decision, reviewed work-item, and evidence provenance. It must
refuse stale, ambiguous, accepted-review, missing-evidence, missing-work-item,
or mismatched-route inputs without creating work items, scheduling agents,
mutating tasks, running providers, writing projections, or touching SCM/forge
state.
