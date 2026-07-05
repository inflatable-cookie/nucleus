# 544 Planning Import Active Apply Admission Model

Status: completed
Owner: Tom
Updated: 2026-07-04
Milestone: `../124-planning-import-active-apply-admission.md`

## Purpose

Model active-apply admission records over stopped apply plans.

## Work

- [x] Add admission request, record, status, blocker, and no-effect types.
- [x] Admit only persisted stopped apply records with explicit operator approval.
- [x] Preserve sanitized stopped apply refs, operation refs, revision
  expectations, and evidence refs.
- [x] Block duplicate no-op, conflict, stale, unsupported, repair-required, and
  effect-widening cases.

## Acceptance Criteria

- [x] Admission records are deterministic and inspectable.
- [x] Blocked records identify the reason apply authority is withheld.
- [x] No active planning records are mutated.
