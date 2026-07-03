# 503 Planning Projection Import Validation

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../117-planning-projection-import-admission.md`

## Purpose

Validate the planning projection import/admission lane.

## Work

- [x] Run focused tests for candidates, admission, conflicts, diagnostics, and
  CLI if present.
- [x] Run docs QA, Northstar QA, diff check, and doctor.
- [x] Confirm `## Next Task` appears only in `docs/roadmaps/README.md`.

## Acceptance Criteria

- [x] Focused tests pass.
- [x] Doctor has zero errors.
- [x] Roadmap and batch-card state remains coherent.

## Evidence

- `cargo test -p nucleus-server planning_projection_import`
- `cargo test -p nucleusd planning_projection_import`
- `cargo fmt --check`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `effigy server:query:planning-projection-import-diagnostics`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `rg "^## Next Task" README.md AGENTS.md docs -n`
- `effigy doctor` reports `err:0` with warning-only god-file findings.
