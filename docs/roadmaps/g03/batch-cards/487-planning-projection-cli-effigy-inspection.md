# 487 Planning Projection CLI Effigy Inspection

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../115-planning-projection-file-export-capture.md`

## Purpose

Expose a read-only CLI/Effigy inspection path for planning projection file
export and capture-prep readiness if the server surface exists.

## Work

- [x] Add `nucleusd` inspection only if a server read model is present.
- [x] Add an Effigy selector only if it improves operator inspection.
- [x] Show counts, file refs, issue classes, and no-effect flags.
- [x] Keep payload dumps, import/apply, and SCM mutation out of scope.

## Acceptance Criteria

- [x] Inspection is read-only and sanitized.
- [x] No projection files are imported or applied.
- [x] No SCM/forge mutation, provider execution, task promotion, or UI behavior
  is added.

## Decision

The first inspection surface is
`planning-projection-file-write-diagnostics`. It reports sanitized counts,
issue classes, and no-effect flags from a read-only server query. Until
planning projection export records are persisted, the query returns an empty
diagnostic snapshot instead of reading payload files or performing writes.
