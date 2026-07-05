# 577 Accepted Memory Import Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../131-accepted-memory-projection-import-validation.md`

## Purpose

Expose accepted-memory projection import validation through root inspection
surfaces.

## Work

- [x] Add a server query for accepted-memory projection import diagnostics.
- [x] Add control-envelope request/response DTOs.
- [x] Add `nucleusd query accepted-memory-import --project <project-id>`.
- [x] Add an Effigy selector for the same query.
- [x] Render candidates, admissions, conflicts, blockers, file refs, and
  no-effect flags without raw memory bodies.

## Acceptance Criteria

- [x] DTO tests cover request/response round trips.
- [x] CLI rendering tests prove sanitized output.
- [x] Effigy selector resolves without package scripts.
- [x] Diagnostics distinguish validation/staging from active apply, SCM/forge,
  embeddings/search, provider sync, task mutation, and UI effects.
