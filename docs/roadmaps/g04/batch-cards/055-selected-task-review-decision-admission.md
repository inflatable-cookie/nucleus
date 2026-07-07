# 055 Selected Task Review Decision Admission

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../012-selected-task-review-decision-controls.md`

## Purpose

Add server-side admission and readiness planning for selected-task review
decisions.

## Work

- [x] Add pure request/response types for review-decision admission.
- [x] Check project id, task id, decision action, operator ref, evidence refs,
  expected revision, idempotency key, and reason requirements.
- [x] Return stable diagnostics for allowed, blocked, stale, duplicate,
  unsupported, missing-evidence, and no-op cases.
- [x] Keep the first implementation pure and side-effect free.

## Acceptance Criteria

- [x] Admission can be tested without database writes.
- [x] Diagnostics are stable and sanitized.
- [x] No provider, SCM, memory, planning, task lifecycle, or UI effects are
  introduced.
- [x] The next card can persist accepted decisions without redesigning the
  admission shape.

## Result

Added `selected_task_review_decision_admission` as a pure server module with
small `builder`, `types`, and `tests` files. It admits explicit operator review
decisions, reports stable refusal statuses, and produces no persistence,
provider, SCM, memory, planning, scheduling, task lifecycle, or UI effects.

Focused validation passed:

- `cargo test -p nucleus-server selected_task_review_decision_admission -- --nocapture`
