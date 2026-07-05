# 549 Planning Import Active Apply Executor Plan Model

Status: completed
Owner: Tom
Updated: 2026-07-04
Milestone: `../125-planning-import-active-apply-executor-boundary.md`

## Purpose

Model stopped executor plans and receipts from active-apply admissions.

## Work

- [x] Add executor plan request, plan, operation, receipt, status, blocker, and
  no-effect types.
- [x] Admit only persisted active-apply admission records.
- [x] Preserve operator approval refs, revision expectations, operation refs,
  and sanitized evidence refs.
- [x] Block stale, conflict, unsupported, repair-required, missing-ref, raw
  payload, and effect-widening cases.

## Acceptance Criteria

- [x] Executor plans are deterministic and inspectable.
- [x] Blocked plans identify why mutation authority is withheld.
- [x] No active planning records are mutated.
