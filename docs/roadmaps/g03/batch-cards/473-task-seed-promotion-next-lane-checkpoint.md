# 473 Task Seed Promotion Next Lane Checkpoint

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../113-task-seed-promotion-command.md`

## Purpose

Choose the next lane after explicit promotion exists.

## Candidate Lanes

- guided planning session records
- management projection implementation for planning records
- task readiness linkage to task seed promotion
- desktop proof surface for planning/task seed workflow

## Acceptance Criteria

- [x] Choice follows implementation evidence.
- [x] Next roadmap has ready cards or an explicit planning gap.

## Result

Selected management projection implementation for planning records as the next
lane.

Reason:

- explicit promotion now works against server-local Planning and Tasks domains
- planning/task seed records still lack concrete committable projection
  payloads
- repo-backed planning state is more foundational than desktop UI or planning
  session depth
- task readiness linkage is useful after projection payloads can represent
  accepted planning state cleanly

Next roadmap:

- `../114-planning-management-projection-payloads.md`
