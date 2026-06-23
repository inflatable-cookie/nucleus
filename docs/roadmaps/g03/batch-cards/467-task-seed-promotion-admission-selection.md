# 467 Task Seed Promotion Admission Selection

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../113-task-seed-promotion-command.md`

## Purpose

Define the admission rules for promoting a planning task seed into a task.

## Work

- [x] Audit task command create behavior and planning seed promotion states.
- [x] Define allowed and blocked seed states.
- [x] Define idempotency expectations for already-promoted seeds.

## Acceptance Criteria

- [x] Admission rules are explicit before mutation code.
- [x] Blocked/rejected/draft seeds cannot create tasks.
- [x] Next implementation card has a bounded command model.

## Result

- Added `docs/architecture/task-seed-promotion-admission.md`.
- Selected accepted review plus explicit `ReadyForPromotion` as the only
  creation-allowed state.
- Blocked draft, review-requested, changes-requested, rejected, superseded,
  not-ready, reviewable, blocked, and already-promoted seeds from creating new
  task records.
- Defined already-promoted idempotency and missing-task repair behavior for the
  next command model.
