# 043 Selected Task Review Next Desktop Proof

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../009-selected-task-review-next-step-presentation.md`

## Purpose

Show selected-task review readiness and next-step context in the disposable
desktop workflow proof.

## Work

- [x] Query the review/next-step read model from the proof surface.
- [x] Present review state, evidence refs, source counts, gaps, and next-step
  category.
- [x] Keep existing task-command controls isolated from review presentation.
- [x] Add focused component guard coverage.

## Acceptance Criteria

- [x] The user can see why the selected task is or is not ready for review.
- [x] The next step is explained from server-owned pathway evidence.
- [x] No review decision, provider, SCM/forge, memory, planning, or final UI
  control is added.

## Result

- The disposable task workflow panel now queries selected-task review/next-step
  state alongside drilldown, action readiness, operator gate, and workflow
  summary.
- It renders review state, evidence boundary counts, source counts, gaps,
  no-effect flags, and pathway-backed next-step category in read-only sections.
- Existing task-command controls remain isolated to admitted task command
  candidates; no review decision or provider/SCM/memory/planning controls were
  added.
