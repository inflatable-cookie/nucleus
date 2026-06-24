# 480 Planning Management Projection Query Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../114-planning-management-projection-payloads.md`

## Purpose

Expose read-only diagnostics for planning projection export readiness if the
export plan needs inspection before filesystem work.

## Work

- [x] Count exportable planning artifacts and task seeds.
- [x] Count blocked, unsupported, and decode-failed records.
- [x] Expose no file-write or SCM authority.

## Acceptance Criteria

- [x] Diagnostics are read-only.
- [x] Output is sanitized.
- [x] No projection file writes occur.
