# 468 Task Seed Promotion Command Model

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../113-task-seed-promotion-command.md`

## Purpose

Implement the first task-domain command model for task seed promotion.

## Work

- [x] Add command input and outcome types.
- [x] Map reviewed seed fields into task create fields.
- [x] Keep agent assignment and provider execution out of scope.

## Acceptance Criteria

- [x] Command creates a task only through task-domain storage.
- [x] Promotion does not schedule work.
- [x] Tests cover accepted and blocked paths.

## Result

- Added pure engine promotion admission/model code under
  `planning_task_seed/promotion.rs`.
- Mapped accepted `ReadyForPromotion` seeds into `EngineTaskCreateCommand`
  with proposed activity and no assignment.
- Kept creation and seed-state mutation deferred for the persistence card.
- Covered accepted, review-requested, rejected, blocking-question,
  already-promoted, and destination mismatch paths.
