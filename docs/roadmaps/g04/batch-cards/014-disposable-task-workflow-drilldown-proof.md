# 014 Disposable Task Workflow Drilldown Proof

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../003-task-workflow-drilldown-and-handoff-readiness.md`

## Purpose

Add a disposable desktop proof path for the task workflow drilldown once the
server and CLI shape is stable.

## Work

- [x] Consume the server-owned drilldown through the existing desktop command
  path.
- [x] Show selected task, timeline refs, runtime refs, review refs, SCM refs,
  gaps, next, and read-only no-effect flags.
- [x] Keep styling minimal and disposable.
- [x] Add guard tests that forbid mutation controls and final-design claims.

## Acceptance Criteria

- [x] The desktop proof can display a selected task drilldown.
- [x] The proof consumes server state and does not become authority.
- [x] No task mutation, provider execution, SCM mutation, or final UI design
  work is introduced.
