# 011 Task Workflow Drilldown Boundary

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../003-task-workflow-drilldown-and-handoff-readiness.md`

## Purpose

Define the first task workflow drilldown boundary and source map before adding
server behavior.

## Work

- [x] Identify existing task, timeline, work progress, runtime, review, and SCM
  source records that can explain one selected task or next ref.
- [x] Define the drilldown summary shape using counts, status labels, and
  stable refs only.
- [x] Define explicit gaps for missing timeline, runtime, review, SCM, and
  next-pathway sources.
- [x] Name the query, DTO, CLI, Effigy, and desktop proof surfaces that may be
  added in later cards.
- [x] Confirm deferred lanes stay out of scope.

## Acceptance Criteria

- [x] The next read model can be implemented without fresh planning decisions.
- [x] The boundary does not require task mutation, provider execution, SCM
  mutation, memory apply, planning apply, or final UI work.
- [x] The selected source map prevents cross-project or cross-task evidence
  leakage.

## Result

The drilldown boundary is recorded in
`../003-task-workflow-drilldown-and-handoff-readiness.md`.

The first implementation should use `project_id` plus `task_id`, then filter
all task, timeline, work-progress, runtime, review, and SCM handoff refs
through that identity pair. Global runtime, command, and SCM evidence may only
enter through task-scoped source edges.

Deferred lanes remain out of scope.
