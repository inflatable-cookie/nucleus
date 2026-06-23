# 465 Planning Task Seed Promotion Readiness Reassessment

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../112-planning-task-seed-persistence-and-projection.md`

## Purpose

Choose whether task seed promotion is ready or another planning lane is needed
first.

## Candidate Lanes

- task seed promotion command
- guided planning session records
- planning artifact repo projection implementation
- task readiness linkage to task seeds

## Acceptance Criteria

- [x] Choice follows persisted inspection evidence.
- [x] Next roadmap has ready cards or an explicit planning gap.

## Decision

Next lane: `../113-task-seed-promotion-command.md`.

Reason:

- persisted task seed records now exist
- read-only inspection is non-empty through Effigy
- promotion remains explicit and can now be modelled as a task-domain command
- management projection implementation can wait until promotion semantics are
  clearer

Deferred:

- guided planning session records
- management projection implementation for planning records
- task readiness linkage to promoted task seeds
