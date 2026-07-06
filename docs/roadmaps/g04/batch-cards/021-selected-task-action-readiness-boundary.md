# 021 Selected Task Action Readiness Boundary

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../005-selected-task-action-readiness.md`

## Purpose

Define the selected-task action readiness boundary before code.

## Work

- [x] Define action families and statuses.
- [x] Map each action family to existing task, work-loop, review, and SCM
  evidence.
- [x] Define stop conditions for mutation, provider execution, SCM execution,
  active apply, and final UI design.
- [x] Name the minimum read-model shape for the next batch.

## Acceptance Criteria

- [x] Action readiness is read-only.
- [x] The action taxonomy is small and product-relevant.
- [x] The next batch is implementation-ready and not a subsystem detour.

## Result

The boundary is recorded in
`../005-selected-task-action-readiness.md`.

The selected-task action taxonomy is intentionally small:

- plan selected task
- start selected task
- block selected task
- complete selected task
- archive selected task
- prepare delegation
- inspect runtime evidence
- review work evidence
- prepare SCM handoff

Each action can be `allowed`, `blocked`, `not_applicable`, or
`different_lane`. These are read-only affordance states, not command
admission.

The minimum read model is a derived view over the existing task workflow
drilldown: selected task identity, readiness lane, task work items, runtime
evidence refs, completion refs, review refs, SCM handoff refs, gap refs,
source counts, blockers, and no-effect flags.
