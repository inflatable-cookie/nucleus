# 544 Planning Import Active Apply Admission Model

Status: planned
Owner: Tom
Updated: 2026-07-03
Milestone: `../124-planning-import-active-apply-admission.md`

## Purpose

Model active-apply admission records over stopped apply plans.

## Work

- [ ] Add admission request, record, status, blocker, and no-effect types.
- [ ] Admit only persisted stopped apply records with explicit operator approval.
- [ ] Preserve sanitized stopped apply refs, operation refs, revision
  expectations, and evidence refs.
- [ ] Block duplicate no-op, conflict, stale, unsupported, repair-required, and
  effect-widening cases.

## Acceptance Criteria

- [ ] Admission records are deterministic and inspectable.
- [ ] Blocked records identify the reason apply authority is withheld.
- [ ] No active planning records are mutated.
