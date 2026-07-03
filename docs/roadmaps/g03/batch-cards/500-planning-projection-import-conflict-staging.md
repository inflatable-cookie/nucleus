# 500 Planning Projection Import Conflict Staging

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../117-planning-projection-import-admission.md`

## Purpose

Stage semantic conflicts from imported planning projection files without
resolving them.

## Work

- [x] Define conflict kinds for artifact body/title, review state, lineage,
  duplicate task seed ids, promotion state, and missing source refs.
- [x] Link conflicts to candidate and admission records.
- [x] Keep conflict resolution and apply behavior out of scope.

## Acceptance Criteria

- [x] Conflict records are inspectable and sanitized.
- [x] Conflict presence blocks import apply.
- [x] Tests cover at least artifact, task seed, and missing-ref conflicts.

## Evidence

- `cargo test -p nucleus-server planning_projection_import_conflicts`
- `cargo test -p nucleus-server planning_projection_import`
- `cargo check -p nucleus-server`
