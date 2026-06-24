# 485 Planning Projection File Write Diagnostics

Status: planned
Owner: Tom
Updated: 2026-06-24
Milestone: `../115-planning-projection-file-export-capture.md`

## Purpose

Expose read-only diagnostics for planning projection file export readiness and
blocked writes.

## Work

- [ ] Count materialized planning artifact files.
- [ ] Count materialized planning task seed files.
- [ ] Count invalid refs, unsupported records, encode failures, and skipped
  writes.
- [ ] Expose no import/apply or SCM authority.

## Acceptance Criteria

- [ ] Diagnostics are sanitized and read-only.
- [ ] Diagnostics cite file refs and issue classes, not raw payload dumps.
- [ ] No projection import, active task creation, SCM/forge mutation, provider
  execution, or UI behavior is added.
