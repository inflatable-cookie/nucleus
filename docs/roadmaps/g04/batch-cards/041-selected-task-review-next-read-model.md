# 041 Selected Task Review Next Read Model

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../009-selected-task-review-next-step-presentation.md`

## Purpose

Build the server-owned selected-task review/next-step read model.

## Work

- [x] Compose review readiness from existing task workflow/work-item evidence.
- [x] Include sanitized source refs and source counts.
- [x] Include pathway-backed next-step category and rationale.
- [x] Prove no effects in focused server tests.

## Acceptance Criteria

- [x] The read model is deterministic and read-only.
- [x] Missing sources are represented as gaps, not guessed outcomes.
- [x] Raw payloads, provider output, SCM mutation, and review mutation stay out.

## Result

- Added `selected_task_review_next` as a small server module with front door,
  types, builder, and focused tests.
- The read model derives review state from existing task workflow/work-item
  evidence and summarizes sanitized receipt, checkpoint, diff, validation,
  timeline, and review refs.
- The next step is derived from review state first, then the existing
  drilldown pathway or explicit planning ambiguity.
- Focused tests cover awaiting-review, needs-changes, accepted-review
  separation from task completion, missing-source gaps, and no-effect flags.
