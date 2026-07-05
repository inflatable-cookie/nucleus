# 580 Accepted Memory Import Apply Admission Records

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../132-accepted-memory-import-apply-admission.md`

## Purpose

Model stopped apply/admission records over validated accepted-memory projection
imports.

## Work

- [x] Add admission request, record, status, blocker, duplicate no-op, and
  no-effect types.
- [x] Admit only validated import candidates with explicit operator approval.
- [x] Preserve candidate refs, memory ids, project ids, file refs, conflict
  refs, provenance refs, and sanitized evidence refs.
- [x] Block conflict, duplicate, unsupported, private/restricted, raw-payload,
  missing-ref, and effect-widening cases.

## Acceptance Criteria

- [x] Admission records are deterministic and inspectable.
- [x] Blocked records identify why apply authority is withheld.
- [x] Active accepted-memory records are not mutated.
