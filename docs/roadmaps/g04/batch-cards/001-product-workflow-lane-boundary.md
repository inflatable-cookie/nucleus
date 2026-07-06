# 001 Product Workflow Lane Boundary

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../001-product-workflow-rebaseline-and-vertical-slice.md`

## Purpose

Define the first g04 vertical slice before implementation.

## Work

- [x] Define the user workflow this slice must explain.
- [x] Inventory existing source records that can support the workflow.
- [x] Define the workflow summary shape at a product level.
- [x] Define explicit non-goals and deferred lanes.
- [x] Add acceptance tests or documentation checks only if they prevent drift.

## Acceptance Criteria

- [x] The slice is product-shaped, not subsystem-shaped.
- [x] The lane uses existing records before creating new mutation surfaces.
- [x] Accepted-memory active apply, provider expansion, SCM/forge mutation,
  final UI, panel layout, plugin runtime, automatic task mutation, and broad
  automation stay out of scope.

## Boundary Result

The first g04 slice is a read-only project workflow summary:

- project and authority posture
- task candidates by workflow lane
- planning/task-seed context
- memory and research context summaries
- runtime/evidence/review state
- SCM readiness or handoff gaps
- next-task source or blocked reason

The slice must compose existing records before adding any new mutation surface.
No acceptance tests were added because the boundary is enforced by docs QA,
Northstar next-task checks, and the next implementation card's focused tests.
