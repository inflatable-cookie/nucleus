# 539 Planning Import Apply Dry Run Plan

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../123-planning-projection-import-review-apply.md`

## Purpose

Add dry-run apply plan records for ready reviewed import admissions.

## Work

- [x] Define dry-run apply plan ids and target refs.
- [x] Include source candidate/admission/evidence refs.
- [x] Include projected operation summaries without payload bodies.
- [x] Include no-effect flags for active planning mutation, task creation,
  projection writes, SCM/forge mutation, provider execution, and UI.

## Acceptance Criteria

- [x] Dry-run plans are inspectable and deterministic.
- [x] Plans do not mutate active planning state.
- [x] Plans do not expose raw projected file payloads or private planning
  bodies.
