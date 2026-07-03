# 501 Planning Projection Import Diagnostics

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../117-planning-projection-import-admission.md`

## Purpose

Expose read-only diagnostics for planning projection import candidates,
admissions, and conflicts.

## Work

- [x] Summarize candidates, admissions, blockers, duplicates, conflicts, and
  evidence refs.
- [x] Surface no-effect flags for apply, task promotion, provider execution,
  SCM/forge mutation, and UI behavior.
- [x] Keep raw projected payloads out of diagnostics.

## Acceptance Criteria

- [x] Diagnostics are deterministic and sanitized.
- [x] Diagnostics can be built from persisted or in-memory stopped records.
- [x] Tests cover empty, ready, blocked, and conflicting sets.

## Evidence

- `cargo test -p nucleus-server planning_projection_import_diagnostics`
- `cargo test -p nucleus-server planning_projection_import`
- `cargo check -p nucleus-server`
