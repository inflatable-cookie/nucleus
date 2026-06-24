# 485 Planning Projection File Write Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../115-planning-projection-file-export-capture.md`

## Purpose

Expose read-only diagnostics for planning projection file export readiness and
blocked writes.

## Work

- [x] Count materialized planning artifact files.
- [x] Count materialized planning task seed files.
- [x] Count invalid refs, unsupported records, encode failures, and skipped
  writes.
- [x] Expose no import/apply or SCM authority.

## Acceptance Criteria

- [x] Diagnostics are sanitized and read-only.
- [x] Diagnostics cite file refs and issue classes, not raw payload dumps.
- [x] No projection import, active task creation, SCM/forge mutation, provider
  execution, or UI behavior is added.
