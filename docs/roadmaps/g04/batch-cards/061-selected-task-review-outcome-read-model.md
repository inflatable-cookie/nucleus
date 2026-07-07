# 061 Selected Task Review Outcome Read Model

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../013-selected-task-review-outcome-routing.md`

## Purpose

Add a server read model that explains the next route after a selected-task
review decision.

## Work

- [x] Add pure route computation over selected-task workflow and
  review-decision records.
- [x] Return route candidates, blockers, source refs, no-effect flags, and
  downstream command hints.
- [x] Keep accepted evidence separate from task completion admission.
- [x] Add focused tests for accepted, rejected, needs-changes, abandoned,
  missing decision, stale task state, and missing evidence cases.

## Acceptance Criteria

- [x] Route computation is read-only and deterministic.
- [x] Tests prove each review decision maps to a bounded next route.
- [x] No provider, SCM, memory, planning, or task lifecycle mutation is added.

## Result

Added `selected_task_review_outcome_route` as a pure server read model with
route candidates, blockers, source counts, downstream command hints, and
explicit no-effect flags.

Focused validation passed:

- `cargo test -p nucleus-server selected_task_review_outcome_route -- --nocapture`
