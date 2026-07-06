# 016 Selected Task Work Loop Boundary

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../004-selected-task-work-loop-composition.md`

## Purpose

Define the selected-task work-loop boundary before adding more code.

## Work

- [x] Map the current selected-task path from project switcher, task list,
  task detail, product workflow summary, and task workflow drilldown.
- [x] Identify which existing records can support action guidance without new
  mutation.
- [x] Define stop conditions for provider execution, SCM mutation, active
  apply, and final UI design.
- [x] Name the minimum read-model or UI composition changes needed for the
  next batch.

## Acceptance Criteria

- [x] The lane has a clear product question and source map.
- [x] Deferred subsystem lanes stay deferred unless the source map proves a
  current workflow need.
- [x] The next batch is implementation-ready and not churn.

## Result

The boundary is captured in
`../004-selected-task-work-loop-composition.md`.

The next implementation batch should extend the existing task workflow
drilldown with read-only guidance fields. It should not add a separate query
unless implementation proves the drilldown would become overloaded.

Existing task transition controls in `TaskDetailPanel.svelte` are not the
selected-task guidance surface. This lane may display guidance, but it must not
add new mutation controls or route users into provider/SCM execution.
