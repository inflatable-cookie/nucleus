# 013 Task Workflow Drilldown CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../003-task-workflow-drilldown-and-handoff-readiness.md`

## Purpose

Expose the task workflow drilldown through serialized control DTOs,
`nucleusd`, and an Effigy selector.

## Work

- [x] Add request and response DTOs for the drilldown query.
- [x] Add `nucleusd query task-workflow-drilldown --project <project-id>
  --task <task-id>`.
- [x] Add a root Effigy selector for local bootstrap inspection.
- [x] Render counts, refs, gaps, next, and no-effect flags without raw payloads.
- [x] Add focused DTO, CLI parser, rendering, and selector smoke tests.

## Acceptance Criteria

- [x] The drilldown can be inspected from the repo root.
- [x] CLI output is useful and clearly read-only.
- [x] The surface does not imply authority to review, complete, publish, or
  schedule work.
