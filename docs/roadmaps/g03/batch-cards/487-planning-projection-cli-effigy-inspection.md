# 487 Planning Projection CLI Effigy Inspection

Status: planned
Owner: Tom
Updated: 2026-06-24
Milestone: `../115-planning-projection-file-export-capture.md`

## Purpose

Expose a read-only CLI/Effigy inspection path for planning projection file
export and capture-prep readiness if the server surface exists.

## Work

- [ ] Add `nucleusd` inspection only if a server read model is present.
- [ ] Add an Effigy selector only if it improves operator inspection.
- [ ] Show counts, file refs, issue classes, and no-effect flags.
- [ ] Keep payload dumps, import/apply, and SCM mutation out of scope.

## Acceptance Criteria

- [ ] Inspection is read-only and sanitized.
- [ ] No projection files are imported or applied.
- [ ] No SCM/forge mutation, provider execution, task promotion, or UI behavior
  is added.
