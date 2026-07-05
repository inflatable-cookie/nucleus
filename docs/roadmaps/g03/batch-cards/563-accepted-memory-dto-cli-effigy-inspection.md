# 563 Accepted Memory DTO CLI Effigy Inspection

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../128-accepted-memory-read-only-inspection.md`

## Purpose

Add a serialized and root-inspectable read-only accepted-memory surface.

## Work

- [x] Add control-envelope request/response DTOs for accepted-memory
  inspection.
- [x] Add `nucleusd query accepted-memory --project <project-id>`.
- [x] Add an Effigy selector for the same query.
- [x] Render ids, counts, refs, sensitivity, retention, and skipped counts
  without raw bodies.

## Acceptance Criteria

- [x] DTO tests cover request/response round trips.
- [x] CLI rendering tests prove sanitized output.
- [x] Effigy selector resolves without adding package scripts.

## Result

Accepted memory now has serialized control-envelope request/response DTOs,
`nucleusd query accepted-memory --project <project-id>`, and the
`effigy server:query:accepted-memory` selector.

The inspection output reports ids, refs, bucket counts, skipped counts, and
explicit no-effect flags without exposing raw memory bodies.
