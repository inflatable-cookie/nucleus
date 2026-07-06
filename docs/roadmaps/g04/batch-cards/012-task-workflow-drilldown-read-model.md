# 012 Task Workflow Drilldown Read Model

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../003-task-workflow-drilldown-and-handoff-readiness.md`

## Purpose

Compose a read-only server-owned task workflow drilldown from the approved
source map.

## Work

- [x] Add task workflow drilldown types with project id, task ref, source
  counts, timeline refs, runtime refs, review refs, SCM refs, gaps, next, and
  no-effect flags.
- [x] Add a server query helper that filters all refs through the selected
  project/task.
- [x] Reuse existing task timeline, task work progress, runtime receipt,
  command evidence, review, and SCM readers where stable.
- [x] Keep missing source families explicit.
- [x] Add focused tests for populated, missing, and cross-task/cross-project
  filtering cases.

## Acceptance Criteria

- [x] Drilldown output explains one selected task or next ref without raw
  payloads.
- [x] Cross-project and cross-task records do not leak into the drilldown.
- [x] No task, provider, SCM, memory, planning, projection, or UI mutation is
  introduced.
