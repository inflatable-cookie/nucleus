# 061 Selected Task Review Outcome Read Model

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../013-selected-task-review-outcome-routing.md`

## Purpose

Add a server read model that explains the next route after a selected-task
review decision.

## Work

- [ ] Add pure route computation over selected-task workflow and
  review-decision records.
- [ ] Return route candidates, blockers, source refs, no-effect flags, and
  downstream command hints.
- [ ] Keep accepted evidence separate from task completion admission.
- [ ] Add focused tests for accepted, rejected, needs-changes, abandoned,
  missing decision, stale task state, and missing evidence cases.

## Acceptance Criteria

- [ ] Route computation is read-only and deterministic.
- [ ] Tests prove each review decision maps to a bounded next route.
- [ ] No provider, SCM, memory, planning, or task lifecycle mutation is added.
