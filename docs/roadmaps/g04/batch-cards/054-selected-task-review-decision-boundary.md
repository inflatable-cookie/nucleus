# 054 Selected Task Review Decision Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../012-selected-task-review-decision-controls.md`

## Purpose

Define the review-decision boundary before adding command behavior.

## Work

- [x] Define review-decision authority, source refs, action vocabulary, and
  no-effect flags in the roadmap.
- [x] Identify which existing selected-task review, timeline, runtime, and SCM
  handoff records can be used as source evidence.
- [x] Define admission inputs, required refs, duplicate/stale rules, and
  outcome diagnostics.
- [x] Keep the boundary separate from task lifecycle mutation, provider
  execution, SCM mutation, memory apply, planning apply, and final UI.

## Acceptance Criteria

- [x] The server remains the only review-decision authority.
- [x] The first decision actions and required fields are explicit.
- [x] Stop conditions are clear enough to prevent accidental task, provider,
  SCM, memory, planning, or client-side authority expansion.
- [x] The next card can implement admission/readiness without another planning
  decision.

## Result

The roadmap now defines server-only review-decision authority, source evidence,
admission inputs, status/refusal vocabulary, compatibility rules, and no-effect
boundaries.
