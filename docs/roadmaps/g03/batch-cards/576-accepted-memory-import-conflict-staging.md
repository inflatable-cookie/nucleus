# 576 Accepted Memory Import Conflict Staging

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../131-accepted-memory-projection-import-validation.md`

## Purpose

Stage semantic conflicts for projected accepted-memory imports without
resolving or applying them.

## Work

- [x] Detect conflicts against active accepted-memory ids, supersession refs,
  review evidence refs, sensitivity/retention policy, and projected file refs.
- [x] Represent duplicate no-ops separately from semantic conflicts.
- [x] Link conflict records to candidate/admission refs.
- [x] Keep conflict staging read-only and review-oriented.

## Acceptance Criteria

- [x] Tests cover duplicate no-op, conflicting body, conflicting supersession,
  and policy conflict cases.
- [x] Tests prove conflict staging does not apply imports or mutate active
  memory.
- [x] Conflict records expose refs and sanitized summaries only.
- [x] SCM/forge, embeddings/search, provider sync, task mutation, and UI remain
  out of scope.
