# 087 Selected Task Server Surface Fit

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../018-product-workflow-ui-architecture-refocus.md`

## Purpose

Decide which existing selected-task server surfaces should back the real UI and
which should remain diagnostics.

## Work

- [x] Inventory selected-task workflow queries used by the proof modal.
- [x] Classify product-facing, diagnostic-only, and redundant surfaces.
- [x] Decide whether a selected-task workflow aggregate query is needed.
- [x] Identify DTO or API gaps before implementation.

## Acceptance Criteria

- [x] Product UI does not require a pile of proof queries for one screen.
- [x] Diagnostic surfaces remain available but isolated.
- [x] Any required aggregate query is specified before code starts.

## Result

Product-facing concepts:

- selected project/task context
- primary next action and reason
- readiness and blockers
- admitted command previews and apply state
- work items and evidence summary
- review next step and review-decision availability
- rework preparation summary
- completion route preview
- SCM handoff readiness

Diagnostic-only surfaces:

- raw DTO shape checks
- no-effect flags
- protocol envelope details
- individual query fallback messages
- source-count chips
- low-level command receipts unless opened from diagnostics

The product shell should consume a selected-task workflow aggregate or a
product client adapter that hides the proof-query cluster behind one product
read model. The proof modal remains available for diagnostics.
