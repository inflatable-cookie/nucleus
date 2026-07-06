# 003 Product Workflow CLI Effigy Inspection

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../001-product-workflow-rebaseline-and-vertical-slice.md`

## Purpose

Expose the product workflow summary through read-only root inspection.

## Work

- [x] Add server query/control DTO shape for the workflow summary.
- [x] Add `nucleusd query` output.
- [x] Add an Effigy selector if stable.
- [x] Add focused DTO, CLI, and selector tests.

## Result

Added read-only `ProductWorkflowSummary` query/control DTO routing, request
handler routing, `nucleusd query product-workflow-summary --project
<project-id>`, and `effigy server:query:product-workflow-summary`.

The query reads project display/status and task readiness lanes from existing
server state. Planning, context, runtime, review, SCM readiness, and next-task
sources remain explicit gaps until their backing source composition is
deliberately added.

## Acceptance Criteria

- [x] The workflow summary can be inspected from the repo root.
- [x] Output is sanitized and readable.
- [x] No provider, SCM/forge, task mutation, accepted-memory apply, final UI,
  or panel-layout effect is added.
